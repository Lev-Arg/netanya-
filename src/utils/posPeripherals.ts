import type { PosReceipt } from '../types.ts';
import { formatMoney } from './api.ts';

// Minimal TypeScript declarations for Web Serial, WebUSB, and BarcodeDetector browser APIs
interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  writable: WritableStream<Uint8Array> | null;
  getInfo?: () => { usbVendorId?: number; usbProductId?: number };
}

interface USBDeviceLike {
  productName?: string;
  manufacturerName?: string;
  configuration: {
    configurationValue: number;
    interfaces: Array<{
      interfaceNumber: number;
      alternate: {
        interfaceClass: number;
        endpoints: Array<{ direction: string; endpointNumber: number }>;
      };
    }>;
  } | null;
  opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<unknown>;
}

export interface PeripheralDeviceHandle {
  transport: 'serial' | 'usb';
  label: string;
  baudRate?: number;
  serialPort?: SerialPortLike;
  usbDevice?: USBDeviceLike;
  usbEndpoint?: number;
}

export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export function isWebUsbSupported(): boolean {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}

export function isCameraBarcodeSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    'BarcodeDetector' in window
  );
}

// Standard ESC/POS Commands
const ESC_INIT = [0x1b, 0x40]; // ESC @
const ESC_ALIGN_CENTER = [0x1b, 0x61, 0x01];
const ESC_ALIGN_LEFT = [0x1b, 0x61, 0x00];
const ESC_BOLD_ON = [0x1b, 0x45, 0x01];
const ESC_BOLD_OFF = [0x1b, 0x45, 0x00];
const GS_CUT_PAPER = [0x1d, 0x56, 0x42, 0x00]; // GS V 66 0 (feed & partial cut)

// RJ11 Cash Drawer Kick pulses (Pin 2 and Pin 5)
export const ESC_POS_DRAWER_KICK_PIN2 = new Uint8Array([0x1b, 0x70, 0x00, 0x19, 0xfa]);
export const ESC_POS_DRAWER_KICK_PIN5 = new Uint8Array([0x1b, 0x70, 0x01, 0x19, 0xfa]);

function encodeAscii(str: string): number[] {
  const bytes: number[] = [];
  const normalized = str.replace(/GH₵/g, 'GHS ');
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    bytes.push(code >= 32 && code <= 126 ? code : code === 10 ? 10 : 32);
  }
  return bytes;
}

function padLine(left: string, right: string, width = 42): string {
  const cleanLeft = left.replace(/GH₵/g, 'GHS ').slice(0, width - right.length - 1);
  const cleanRight = right.replace(/GH₵/g, 'GHS ');
  const spaces = Math.max(1, width - cleanLeft.length - cleanRight.length);
  return `${cleanLeft}${' '.repeat(spaces)}${cleanRight}\n`;
}

export function buildEscPosReceiptBytes(
  receipt: PosReceipt,
  options: { kickDrawer?: boolean } = {}
): Uint8Array {
  const buf: number[] = [];
  const push = (...arr: number[]) => buf.push(...arr);
  const text = (s: string) => buf.push(...encodeAscii(s));

  push(...ESC_INIT);
  push(...ESC_ALIGN_CENTER, ...ESC_BOLD_ON);
  text('NETANYA PHARMACY & RETAIL SHOP\n');
  push(...ESC_BOLD_OFF);
  text('Accra, Ghana\n');
  text('Your Health is Our Number One Priority\n');
  text('------------------------------------------\n');
  push(...ESC_ALIGN_LEFT);

  text(padLine(`Receipt: ${receipt.receiptNumber}`, new Date(receipt.createdAt).toLocaleDateString('en-GH')));
  text(`Time:     ${new Date(receipt.createdAt).toLocaleTimeString('en-GH')}\n`);
  text(`Cashier:  ${receipt.cashierName}\n`);
  text(`Customer: ${receipt.customerName}\n`);
  text(
    `Paid via: ${
      receipt.paymentMethod === 'mobile_pay' ? 'MoMo / GhQR' : receipt.paymentMethod.toUpperCase()
    }\n`
  );
  text('------------------------------------------\n');

  for (const item of receipt.otcLines) {
    text(`${item.name}\n`);
    text(
      padLine(
        `  ${item.quantity} x ${formatMoney(item.unitPriceCents)}`,
        formatMoney(item.unitPriceCents * item.quantity)
      )
    );
  }
  for (const srv of receipt.serviceLines || []) {
    text(`Test: ${srv.name}\n`);
    text(
      padLine(
        `  ${srv.quantity} x ${formatMoney(srv.priceCents)} (Exempt)`,
        formatMoney(srv.priceCents * srv.quantity)
      )
    );
  }
  for (const rx of receipt.rxLines) {
    text(`Rx ${rx.rxNumber}: ${rx.medicationName}\n`);
    text(padLine('  Patient Copay (Exempt)', formatMoney(rx.copayCents)));
  }

  text('------------------------------------------\n');
  text(padLine('OTC Subtotal', formatMoney(receipt.subtotalCents)));
  if (receipt.discountCents > 0) {
    text(padLine(`Discount (${receipt.discountPercent}%)`, `-${formatMoney(receipt.discountCents)}`));
  }
  text(padLine('VAT (15% Retail)', formatMoney(receipt.taxCents)));
  if ((receipt.serviceTotalCents || 0) > 0) {
    text(padLine('Tests & Services', formatMoney(receipt.serviceTotalCents || 0)));
  }
  if (receipt.rxCopayTotalCents > 0) {
    text(padLine('Rx Copays', formatMoney(receipt.rxCopayTotalCents)));
  }

  push(...ESC_BOLD_ON);
  text(padLine('TOTAL PAID', formatMoney(receipt.grandTotalCents)));
  push(...ESC_BOLD_OFF);
  text(padLine('Tendered', formatMoney(receipt.tenderedCents)));
  if (receipt.changeDueCents > 0) {
    text(padLine('Change Given', formatMoney(receipt.changeDueCents)));
  }

  text('------------------------------------------\n');
  push(...ESC_ALIGN_CENTER);
  text('Thank you for trusting Netanya Pharmacy!\n\n\n');
  push(...GS_CUT_PAPER);

  if (options.kickDrawer) {
    push(...ESC_POS_DRAWER_KICK_PIN2);
  }

  return new Uint8Array(buf);
}

export async function connectSerialPeripheral(baudRate = 9600): Promise<PeripheralDeviceHandle> {
  const nav = navigator as unknown as {
    serial?: { requestPort: () => Promise<SerialPortLike> };
  };
  if (!nav.serial) {
    throw new Error('Web Serial is not supported in this browser. Use Chrome or Edge on desktop.');
  }
  const port = await nav.serial.requestPort();
  await port.open({ baudRate });
  const info = port.getInfo?.();
  const label = info?.usbVendorId
    ? `Serial Port (${info.usbVendorId.toString(16).toUpperCase()}:${(info.usbProductId || 0)
        .toString(16)
        .toUpperCase()})`
    : `Serial Device (${baudRate} baud)`;
  return {
    transport: 'serial',
    label,
    baudRate,
    serialPort: port,
  };
}

export async function connectUsbPrinterPeripheral(): Promise<PeripheralDeviceHandle> {
  const nav = navigator as unknown as {
    usb?: { requestDevice: (opts: { filters: Array<Record<string, unknown>> }) => Promise<USBDeviceLike> };
  };
  if (!nav.usb) {
    throw new Error('WebUSB is not supported in this browser. Use Chrome or Edge.');
  }
  // Class 7 = Printer; allow generic picker fallback as well
  const device = await nav.usb.requestDevice({ filters: [{ classCode: 7 }] });
  if (!device.opened) {
    await device.open();
  }
  if (!device.configuration) {
    await device.selectConfiguration(1);
  }
  const iface =
    device.configuration?.interfaces.find((i) => i.alternate.interfaceClass === 7) ||
    device.configuration?.interfaces[0];
  if (!iface) {
    throw new Error('Selected USB device does not expose a printable interface.');
  }
  await device.claimInterface(iface.interfaceNumber);
  const outEndpoint = iface.alternate.endpoints.find((e) => e.direction === 'out');
  if (!outEndpoint) {
    throw new Error('No USB OUT endpoint found on printer.');
  }
  return {
    transport: 'usb',
    label: device.productName || device.manufacturerName || 'USB ESC/POS Printer',
    usbDevice: device,
    usbEndpoint: outEndpoint.endpointNumber,
  };
}

export async function disconnectPeripheral(handle: PeripheralDeviceHandle | null): Promise<void> {
  if (!handle) return;
  try {
    if (handle.serialPort) await handle.serialPort.close();
    if (handle.usbDevice && handle.usbDevice.opened) await handle.usbDevice.close();
  } catch {
    // Ignore close errors if cable was unplugged
  }
}

export async function writeBytesToPeripheral(
  handle: PeripheralDeviceHandle,
  bytes: Uint8Array
): Promise<void> {
  if (handle.transport === 'serial' && handle.serialPort) {
    if (!handle.serialPort.writable) {
      throw new Error('Serial peripheral is not writable.');
    }
    const writer = handle.serialPort.writable.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
    return;
  }
  if (handle.transport === 'usb' && handle.usbDevice && handle.usbEndpoint !== undefined) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    await handle.usbDevice.transferOut(handle.usbEndpoint, copy.buffer);
    return;
  }
  throw new Error('No active hardware port connected.');
}

export async function sendCashDrawerKick(handle: PeripheralDeviceHandle): Promise<void> {
  // Send standard RJ11 Pin 2 pulse (and brief Pin 5 fallback pulse supported by dual-pin drawers)
  const combined = new Uint8Array(ESC_POS_DRAWER_KICK_PIN2.length + ESC_POS_DRAWER_KICK_PIN5.length);
  combined.set(ESC_POS_DRAWER_KICK_PIN2, 0);
  combined.set(ESC_POS_DRAWER_KICK_PIN5, ESC_POS_DRAWER_KICK_PIN2.length);
  await writeBytesToPeripheral(handle, combined);
}

export function printReceiptViaSystemPrinter(receipt: PosReceipt): void {
  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const itemRows = [
    ...receipt.otcLines.map(
      (l) => `
      <div class="row"><span>${esc(l.name)} (x${l.quantity})</span><span>${esc(
        formatMoney(l.unitPriceCents * l.quantity)
      )}</span></div>`
    ),
    ...(receipt.serviceLines || []).map(
      (s) => `
      <div class="row"><span>Test: ${esc(s.name)} (x${s.quantity})</span><span>${esc(
        formatMoney(s.priceCents * s.quantity)
      )}</span></div>`
    ),
    ...receipt.rxLines.map(
      (rx) => `
      <div class="row"><span>Rx ${esc(rx.rxNumber)} · ${esc(rx.medicationName)}</span><span>${esc(
        formatMoney(rx.copayCents)
      )}</span></div>`
    ),
  ].join('');

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Receipt ${esc(receipt.receiptNumber)}</title>
<style>
  @page { size: 80mm auto; margin: 4mm; }
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #0f172a; margin: 0; padding: 8px; width: 72mm; }
  .center { text-align: center; }
  .bold { font-weight: 700; }
  .hr { border-top: 1px dashed #64748b; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; gap: 8px; margin: 2px 0; }
  .total { font-size: 13px; font-weight: 700; margin-top: 4px; }
  .meta { font-size: 10px; color: #334155; }
</style>
</head>
<body>
  <div class="center">
    <div class="bold">NETANYA PHARMACY &amp; RETAIL SHOP</div>
    <div class="meta">Accra, Ghana · Walk-In Counter</div>
  </div>
  <div class="hr"></div>
  <div class="meta">
    <div class="row"><span>Receipt #</span><span class="bold">${esc(receipt.receiptNumber)}</span></div>
    <div class="row"><span>Date</span><span>${esc(new Date(receipt.createdAt).toLocaleString('en-GH'))}</span></div>
    <div class="row"><span>Cashier</span><span>${esc(receipt.cashierName)}</span></div>
    <div class="row"><span>Customer</span><span>${esc(receipt.customerName)}</span></div>
    <div class="row"><span>Paid By</span><span>${esc(
      receipt.paymentMethod === 'mobile_pay' ? 'MoMo / GhQR' : receipt.paymentMethod.toUpperCase()
    )}</span></div>
  </div>
  <div class="hr"></div>
  ${itemRows}
  <div class="hr"></div>
  <div class="row"><span>OTC Subtotal</span><span>${esc(formatMoney(receipt.subtotalCents))}</span></div>
  ${
    receipt.discountCents > 0
      ? `<div class="row"><span>Discount (${receipt.discountPercent}%)</span><span>-${esc(
          formatMoney(receipt.discountCents)
        )}</span></div>`
      : ''
  }
  <div class="row"><span>VAT (15% · Rx Exempt)</span><span>${esc(formatMoney(receipt.taxCents))}</span></div>
  ${
    (receipt.serviceTotalCents || 0) > 0
      ? `<div class="row"><span>Tests &amp; Services</span><span>${esc(
          formatMoney(receipt.serviceTotalCents || 0)
        )}</span></div>`
      : ''
  }
  ${
    receipt.rxCopayTotalCents > 0
      ? `<div class="row"><span>Rx Copay</span><span>${esc(formatMoney(receipt.rxCopayTotalCents))}</span></div>`
      : ''
  }
  <div class="row total"><span>TOTAL PAID</span><span>${esc(formatMoney(receipt.grandTotalCents))}</span></div>
  <div class="row meta"><span>Tendered</span><span>${esc(formatMoney(receipt.tenderedCents))}</span></div>
  ${
    receipt.changeDueCents > 0
      ? `<div class="row meta bold"><span>Change Given</span><span>${esc(
          formatMoney(receipt.changeDueCents)
        )}</span></div>`
      : ''
  }
  <div class="hr"></div>
  <div class="center meta">Thank you for trusting Netanya Pharmacy!</div>
</body>
</html>`;

  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.setAttribute('aria-hidden', 'true');
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc || !iframe.contentWindow) {
    document.body.removeChild(iframe);
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();

  setTimeout(() => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } finally {
      setTimeout(() => {
        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe);
        }
      }, 1500);
    }
  }, 150);
}
