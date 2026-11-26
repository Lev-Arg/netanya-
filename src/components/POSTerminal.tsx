import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Banknote,
  Barcode,
  Camera,
  CheckCircle2,
  CreditCard,
  Download,
  ExternalLink,
  History,
  Info,
  KeyRound,
  Lock,
  LockOpen,
  Minus,
  Pill,
  Plus,
  Printer,
  Receipt,
  Search,
  Settings2,
  ShieldAlert,
  Smartphone,
  Trash2,
  Usb,
  X,
} from 'lucide-react';
import {
  INVENTORY_CATEGORIES,
  type CashDrawerEvent,
  type CashDrawerTrigger,
  type InsuranceClaim,
  type InventoryCategory,
  type InventoryItem,
  type OtcOrder,
  type PharmacyService,
  type PosReceipt,
  type Prescription,
  type UserRole,
} from '../types.ts';
import { apiFetch, formatMoney } from '../utils/api.ts';
import {
  buildEscPosReceiptBytes,
  connectSerialPeripheral,
  connectUsbPrinterPeripheral,
  disconnectPeripheral,
  isCameraBarcodeSupported,
  isWebSerialSupported,
  isWebUsbSupported,
  printReceiptViaSystemPrinter,
  sendCashDrawerKick,
  writeBytesToPeripheral,
  type PeripheralDeviceHandle,
} from '../utils/posPeripherals.ts';

interface POSTerminalProps {
  inventory: InventoryItem[];
  services: PharmacyService[];
  prescriptions: Prescription[];
  claims: InsuranceClaim[];
  recentOrders: OtcOrder[];
  posReceipts: PosReceipt[];
  drawerEvents?: CashDrawerEvent[];
  cashierName?: string;
  cashierRole?: UserRole;
  preselectedRxId?: string | null;
  onClearPreselectedRx?: () => void;
  onOrderStatusChange: (
    orderId: string,
    status: 'confirmed' | 'ready_for_pickup' | 'dispatched'
  ) => Promise<void> | void;
  onSaleCompleted: (message: string) => Promise<void> | void;
}

interface CounterLine {
  item: InventoryItem;
  quantity: number;
}

interface ServiceTicketLine {
  service: PharmacyService;
  quantity: number;
}

type CounterView =
  | 'ALL'
  | InventoryCategory
  | 'SERVICES'
  | 'RX_PICKUP'
  | 'ONLINE_ORDERS'
  | 'RECEIPTS';

export const POSTerminal: React.FC<POSTerminalProps> = ({
  inventory,
  services,
  prescriptions,
  claims,
  recentOrders,
  posReceipts,
  drawerEvents = [],
  cashierName = 'Pharmacist',
  cashierRole = 'pharmacist',
  preselectedRxId,
  onClearPreselectedRx,
  onOrderStatusChange,
  onSaleCompleted,
}) => {
  const [counterView, setCounterView] = useState<CounterView>('ALL');
  const [query, setQuery] = useState('');
  const [ticketOtc, setTicketOtc] = useState<CounterLine[]>([]);
  const [ticketServices, setTicketServices] = useState<ServiceTicketLine[]>([]);
  const [ticketRxIds, setTicketRxIds] = useState<string[]>([]);
  const [customerName, setCustomerName] = useState('Walk-In Customer');
  const [customerEmail, setCustomerEmail] = useState('');
  const [discountPercent, setDiscountPercent] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState<'mobile_pay' | 'cash' | 'card'>('mobile_pay');
  const [cashTenderDollars, setCashTenderDollars] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [momoPhone, setMomoPhone] = useState('');
  const [momoProvider, setMomoProvider] = useState<'mtn' | 'atl' | 'vod'>('mtn');
  const [momoRequest, setMomoRequest] = useState<{ reference: string; status: string } | null>(null);
  const [momoSending, setMomoSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastReceipt, setLastReceipt] = useState<PosReceipt | null>(null);
  const [selectedInfoItem, setSelectedInfoItem] = useState<InventoryItem | null>(null);

  // Peripherals: Hardware device, Auto-print / Auto-drawer settings, HID & Camera Scanner, Cash Drawer Authorization
  const [hardwareDevice, setHardwareDevice] = useState<PeripheralDeviceHandle | null>(null);
  const [serialBaudRate, setSerialBaudRate] = useState<number>(9600);
  const [autoPrintOnSale, setAutoPrintOnSale] = useState<boolean>(false);
  const [autoKickDrawerOnCash, setAutoKickDrawerOnCash] = useState<boolean>(true);
  const [hidScannerEnabled, setHidScannerEnabled] = useState<boolean>(true);
  const [hardwareBanner, setHardwareBanner] = useState<string | null>(null);
  const [peripheralModal, setPeripheralModal] = useState<
    null | 'hardware_setup' | 'camera_scan' | 'drawer_auth' | 'drawer_logs'
  >(null);

  // Camera Scanner State
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Authorized Cash Drawer Unlock Modal State
  const [drawerTrigger, setDrawerTrigger] = useState<CashDrawerTrigger>('manual_no_sale');
  const [drawerReason, setDrawerReason] = useState('');
  const [drawerAuthEmail, setDrawerAuthEmail] = useState('');
  const [drawerPassword, setDrawerPassword] = useState('');
  const [drawerAuthBusy, setDrawerAuthBusy] = useState(false);
  const [drawerAuthError, setDrawerAuthError] = useState<string | null>(null);
  const [drawerRecentlyUnlocked, setDrawerRecentlyUnlocked] = useState<string | null>(null);

  const counterItems = useMemo(
    () => inventory.filter((i) => !i.requiresPrescription),
    [inventory]
  );

  const activeCounterCategories = useMemo(
    () => INVENTORY_CATEGORIES.filter((cat) => counterItems.some((i) => i.category === cat)),
    [counterItems]
  );

  const activeServices = useMemo(
    () => services.filter((s) => s.active),
    [services]
  );

  const pickupPrescriptions = useMemo(
    () => prescriptions.filter((rx) => rx.status === 'ready' || rx.status === 'verifying'),
    [prescriptions]
  );

  const openOnlineOrders = useMemo(
    () => recentOrders.filter((o) => o.status !== 'dispatched'),
    [recentOrders]
  );

  useEffect(() => {
    if (!preselectedRxId) return;
    const rx = pickupPrescriptions.find((r) => r.id === preselectedRxId);
    if (rx) {
      setCounterView('RX_PICKUP');
      setTicketRxIds((prev) => (prev.includes(rx.id) ? prev : [...prev, rx.id]));
      setCustomerName(rx.patientName);
      setLastReceipt(null);
    }
    onClearPreselectedRx?.();
  }, [preselectedRxId, pickupPrescriptions, onClearPreselectedRx]);

  const getRxPaymentInfo = (rx: Prescription): { copayCents: number; coveredByInsurance: boolean; payerName?: string } => {
    const claim = claims.find(
      (c) =>
        c.prescriptionId === rx.id &&
        (c.claimStatus === 'adjudicated' || c.claimStatus === 'paid')
    );
    if (claim) {
      return {
        copayCents: claim.patientCopayCents,
        coveredByInsurance: true,
        payerName: claim.payerName,
      };
    }
    return { copayCents: rx.unitPriceCents, coveredByInsurance: false };
  };

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    const isCatView = (INVENTORY_CATEGORIES as readonly string[]).includes(counterView);
    return counterItems.filter((item) => {
      if (isCatView && item.category !== counterView) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q) ||
        item.ndcCode.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q)
      );
    });
  }, [counterItems, counterView, query]);

  const filteredServices = useMemo(() => {
    const q = query.trim().toLowerCase();
    return activeServices.filter((s) => {
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        s.notes.toLowerCase().includes(q)
      );
    });
  }, [activeServices, query]);

  const filteredPickups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pickupPrescriptions.filter((rx) => {
      if (!q) return true;
      return (
        rx.rxNumber.toLowerCase().includes(q) ||
        rx.patientName.toLowerCase().includes(q) ||
        rx.medicationName.toLowerCase().includes(q)
      );
    });
  }, [pickupPrescriptions, query]);

  const addOtcItem = (item: InventoryItem) => {
    if (item.stockQuantity <= 0) return;
    setError(null);
    setLastReceipt(null);
    setTicketOtc((prev) => {
      const existing = prev.find((l) => l.item.id === item.id);
      if (existing) {
        const nextQty = Math.min(item.stockQuantity, existing.quantity + 1);
        return prev.map((l) => (l.item.id === item.id ? { ...l, quantity: nextQty } : l));
      }
      return [...prev, { item, quantity: 1 }];
    });
  };

  const updateLineQty = (inventoryId: string, delta: number) => {
    setTicketOtc((prev) =>
      prev
        .map((line) => {
          if (line.item.id !== inventoryId) return line;
          const next = Math.min(line.item.stockQuantity, line.quantity + delta);
          return next <= 0 ? null : { ...line, quantity: next };
        })
        .filter((x): x is CounterLine => x !== null)
    );
  };

  const addServiceItem = (service: PharmacyService) => {
    setError(null);
    setLastReceipt(null);
    setTicketServices((prev) => {
      const existing = prev.find((s) => s.service.id === service.id);
      if (existing) {
        return prev.map((s) =>
          s.service.id === service.id ? { ...s, quantity: Math.min(20, s.quantity + 1) } : s
        );
      }
      return [...prev, { service, quantity: 1 }];
    });
  };

  const updateServiceQty = (serviceId: string, delta: number) => {
    setTicketServices((prev) =>
      prev
        .map((line) => {
          if (line.service.id !== serviceId) return line;
          const next = line.quantity + delta;
          return next <= 0 ? null : { ...line, quantity: Math.min(20, next) };
        })
        .filter((x): x is ServiceTicketLine => x !== null)
    );
  };

  const toggleRxPickup = (rx: Prescription) => {
    setError(null);
    setLastReceipt(null);
    setTicketRxIds((prev) =>
      prev.includes(rx.id) ? prev.filter((id) => id !== rx.id) : [...prev, rx.id]
    );
    if (customerName === 'Walk-In Customer') {
      setCustomerName(rx.patientName);
    }
  };

  const resolveScannedBarcode = useCallback(
    (rawCode: string): boolean => {
      const code = rawCode.trim();
      if (!code) return false;
      const lower = code.toLowerCase();

      const itemMatch = counterItems.find(
        (i) => i.ndcCode.toLowerCase() === lower || i.id.toLowerCase() === lower
      );
      if (itemMatch) {
        if (itemMatch.stockQuantity <= 0) {
          setError(`${itemMatch.name} (${itemMatch.ndcCode}) is out of stock.`);
          return false;
        }
        addOtcItem(itemMatch);
        setHardwareBanner(`Scanned ${itemMatch.name} (${itemMatch.ndcCode}) -> added to bill.`);
        setQuery('');
        return true;
      }

      const rxMatch = pickupPrescriptions.find((rx) => rx.rxNumber.toLowerCase() === lower);
      if (rxMatch) {
        setCounterView('RX_PICKUP');
        setTicketRxIds((prev) => (prev.includes(rxMatch.id) ? prev : [...prev, rxMatch.id]));
        if (customerName === 'Walk-In Customer') setCustomerName(rxMatch.patientName);
        setHardwareBanner(`Scanned Rx ${rxMatch.rxNumber} (${rxMatch.medicationName}) -> added.`);
        setQuery('');
        return true;
      }

      const orderMatch = openOnlineOrders.find((o) => o.orderNumber.toLowerCase() === lower);
      if (orderMatch) {
        setCounterView('ONLINE_ORDERS');
        setHardwareBanner(`Found pickup order ${orderMatch.orderNumber} (${orderMatch.customerName}).`);
        setQuery('');
        return true;
      }

      setError(`No stocked shelf item, ready Rx, or open order matched barcode "${code}".`);
      return false;
    },
    [counterItems, pickupPrescriptions, openOnlineOrders, customerName]
  );

  const handleBarcodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    if (resolveScannedBarcode(q)) return;
    if (filteredItems.length === 1 && filteredItems[0].stockQuantity > 0) {
      addOtcItem(filteredItems[0]);
      setError(null);
      setHardwareBanner(`Added ${filteredItems[0].name} to bill.`);
      setQuery('');
    }
  };

  // Global USB / Bluetooth HID Hardware Barcode Scanner listener (rapid keystrokes ending in Enter)
  useEffect(() => {
    if (!hidScannerEnabled || peripheralModal !== null) return;
    let buffer = '';
    let lastKeyTime = 0;

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      const now = Date.now();
      if (now - lastKeyTime > 70) {
        buffer = '';
      }
      lastKeyTime = now;

      if (e.key === 'Enter') {
        if (buffer.length >= 4) {
          e.preventDefault();
          const scanned = buffer;
          buffer = '';
          resolveScannedBarcode(scanned);
        } else {
          buffer = '';
        }
        return;
      }

      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        buffer += e.key;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hidScannerEnabled, peripheralModal, resolveScannedBarcode]);

  // Camera BarcodeDetector scanner loop when camera modal is open
  useEffect(() => {
    if (peripheralModal !== 'camera_scan') {
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach((t) => t.stop());
        cameraStreamRef.current = null;
      }
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;
    setCameraError(null);

    if (!isCameraBarcodeSupported()) {
      setCameraError(
        'Camera BarcodeDetector is unavailable in this browser. Use a USB/Bluetooth barcode scanner or type the code above.'
      );
      return;
    }

    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        cameraStreamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        const DetectorCtor = (
          window as unknown as {
            BarcodeDetector: new (opts: { formats: string[] }) => {
              detect: (src: HTMLVideoElement) => Promise<Array<{ rawValue: string }>>;
            };
          }
        ).BarcodeDetector;
        const detector = new DetectorCtor({
          formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'],
        });

        const tick = async () => {
          if (cancelled) return;
          if (videoRef.current && videoRef.current.readyState >= 2) {
            try {
              const found = await detector.detect(videoRef.current);
              if (found.length > 0 && found[0].rawValue) {
                resolveScannedBarcode(found[0].rawValue);
                setPeripheralModal(null);
                return;
              }
            } catch {
              // Ignore single-frame detection errors
            }
          }
          timerId = window.setTimeout(tick, 350);
        };
        timerId = window.setTimeout(tick, 400);
      } catch (err) {
        if (!cancelled) {
          setCameraError(
            err instanceof Error
              ? `Camera could not start (${err.message}). Plug in a USB scanner or search manually.`
              : 'Camera permission denied.'
          );
        }
      }
    };

    startCamera();
    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach((t) => t.stop());
        cameraStreamRef.current = null;
      }
    };
  }, [peripheralModal, resolveScannedBarcode]);

  const otcSubtotalCents = useMemo(
    () => ticketOtc.reduce((sum, l) => sum + l.item.unitPriceCents * l.quantity, 0),
    [ticketOtc]
  );
  const discountCents = Math.round(otcSubtotalCents * (discountPercent / 100));
  const discountedSubtotal = Math.max(0, otcSubtotalCents - discountCents);
  const taxCents = Math.round(discountedSubtotal * 0.15);
  const otcTotalCents = discountedSubtotal + taxCents;

  const attachedPickups = useMemo(
    () => pickupPrescriptions.filter((rx) => ticketRxIds.includes(rx.id)),
    [pickupPrescriptions, ticketRxIds]
  );

  const rxCopayTotalCents = useMemo(
    () => attachedPickups.reduce((sum, rx) => sum + getRxPaymentInfo(rx).copayCents, 0),
    [attachedPickups, claims]
  );

  const serviceTotalCents = useMemo(
    () => ticketServices.reduce((sum, s) => sum + s.service.priceCents * s.quantity, 0),
    [ticketServices]
  );

  const grandTotalCents = otcTotalCents + rxCopayTotalCents + serviceTotalCents;
  const tenderedCents =
    paymentMethod === 'cash'
      ? Math.round((Number(cashTenderDollars) || grandTotalCents / 100) * 100)
      : grandTotalCents;
  const changeDueCents =
    paymentMethod === 'cash' ? Math.max(0, tenderedCents - grandTotalCents) : 0;

  const hasBillLines =
    ticketOtc.length > 0 || ticketRxIds.length > 0 || ticketServices.length > 0;

  const handlePrintReceipt = async (receipt: PosReceipt, kickDrawerIfCash = false) => {
    const transportUsed = hardwareDevice
      ? `${hardwareDevice.transport}_escpos`
      : 'system_printer_80mm';
    try {
      if (hardwareDevice) {
        const bytes = buildEscPosReceiptBytes(receipt, { kickDrawer: kickDrawerIfCash });
        await writeBytesToPeripheral(hardwareDevice, bytes);
        setHardwareBanner(
          `Printed ${receipt.receiptNumber} on ${hardwareDevice.label}${
            kickDrawerIfCash ? ' & pulsed cash drawer' : ''
          }.`
        );
      } else {
        printReceiptViaSystemPrinter(receipt);
        setHardwareBanner(`Sent ${receipt.receiptNumber} (80mm) to system printer.`);
      }
      await apiFetch('/api/staff/peripherals/receipt-print', {
        method: 'POST',
        body: JSON.stringify({ receiptNumber: receipt.receiptNumber, transport: transportUsed }),
      }).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Receipt printer error.');
    }
  };

  const billPayload = () => ({
    customerName,
    customerEmail,
    discountPercent,
    otcItems: ticketOtc.map((l) => ({ inventoryId: l.item.id, quantity: l.quantity })),
    prescriptionIds: ticketRxIds,
    serviceItems: ticketServices.map((s) => ({
      serviceId: s.service.id,
      quantity: s.quantity,
    })),
  });

  const handleSendMomoPrompt = async () => {
    if (!hasBillLines || momoSending) return;
    setMomoSending(true);
    setError(null);
    try {
      const res = await apiFetch<{
        reference: string;
        status: string;
        grandTotalCents: number;
        displayText?: string | null;
      }>('/api/staff/pos/payment-requests', {
        method: 'POST',
        body: JSON.stringify({
          ...billPayload(),
          customerPhone: momoPhone.trim(),
          momoProvider,
        }),
      });
      setMomoRequest({ reference: res.reference, status: res.status });
      setPaymentReference(res.status === 'success' ? res.reference : '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send payment prompt.');
    } finally {
      setMomoSending(false);
    }
  };

  // Poll the charge until the customer approves/expires (~180s network window).
  useEffect(() => {
    if (!momoRequest || (momoRequest.status !== 'pending' && momoRequest.status !== 'pay_offline' && momoRequest.status !== 'send_otp')) {
      return;
    }
    const timer = window.setInterval(async () => {
      try {
        const res = await apiFetch<{ reference: string; status: string }>(
          `/api/staff/pos/payment-requests/${encodeURIComponent(momoRequest.reference)}`
        );
        setMomoRequest({ reference: res.reference, status: res.status });
        if (res.status === 'success') {
          setPaymentReference(res.reference);
        }
      } catch {
        // transient poll failure — keep waiting
      }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [momoRequest]);

  // Any bill change invalidates a collected electronic payment.
  useEffect(() => {
    setMomoRequest(null);
    setPaymentReference('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketOtc, ticketServices, ticketRxIds, discountPercent]);

  const handleCheckout = async () => {
    if (!hasBillLines) return;
    if (paymentMethod !== 'cash' && !paymentReference.trim()) {
      setError('Complete the verified mobile money payment or enter a payment reference.');
      return;
    }
    if (paymentMethod === 'cash' && cashTenderDollars && tenderedCents < grandTotalCents) {
      setError('Cash received is less than the total due.');
      return;
    }

    const activeTransport = hardwareDevice
      ? `${hardwareDevice.transport}_escpos`
      : 'system_counter';

    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{
        receipt: PosReceipt;
        drawerAuthorized?: boolean;
      }>('/api/staff/pos/checkout', {
        method: 'POST',
        body: JSON.stringify({
          ...billPayload(),
          paymentMethod,
          tenderedCents,
          paymentReference: paymentMethod === 'cash' ? undefined : paymentReference.trim(),
          hardwareTransport: activeTransport,
        }),
      });
      setLastReceipt(res.receipt);
      setTicketOtc([]);
      setTicketServices([]);
      setTicketRxIds([]);
      setDiscountPercent(0);
      setCashTenderDollars('');
      setPaymentReference('');
      setMomoPhone('');
      setMomoRequest(null);
      setCustomerName('Walk-In Customer');
      setCustomerEmail('');

      // Authorized Hardware Actions after confirmed checkout
      const shouldKickDrawer = Boolean(res.drawerAuthorized && autoKickDrawerOnCash);
      if (autoPrintOnSale) {
        await handlePrintReceipt(res.receipt, shouldKickDrawer);
      } else if (shouldKickDrawer && hardwareDevice) {
        await sendCashDrawerKick(hardwareDevice).catch(() => {});
        setHardwareBanner(
          `Cash sale ${res.receipt.receiptNumber} authorized -> sent drawer kick pulse to ${hardwareDevice.label}.`
        );
      } else if (shouldKickDrawer) {
        setDrawerRecentlyUnlocked(res.receipt.receiptNumber);
        setTimeout(() => setDrawerRecentlyUnlocked(null), 5000);
      }

      if (shouldKickDrawer && hardwareDevice) {
        setDrawerRecentlyUnlocked(res.receipt.receiptNumber);
        setTimeout(() => setDrawerRecentlyUnlocked(null), 5000);
      }

      await onSaleCompleted(
        res.receipt.poTriggered
          ? `Sale ${res.receipt.receiptNumber} saved. Low stock triggered a supplier restock order.`
          : `Sale ${res.receipt.receiptNumber} saved (${formatMoney(res.receipt.grandTotalCents)}).`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete the sale.');
    } finally {
      setBusy(false);
    }
  };

  const handleConnectSerial = async () => {
    try {
      await disconnectPeripheral(hardwareDevice);
      const dev = await connectSerialPeripheral(serialBaudRate);
      setHardwareDevice(dev);
      setHardwareBanner(`Connected ${dev.label} for ESC/POS printing & RJ11 cash drawer.`);
    } catch (err) {
      setHardwareBanner(err instanceof Error ? err.message : 'Could not open Serial port.');
    }
  };

  const handleConnectUsb = async () => {
    try {
      await disconnectPeripheral(hardwareDevice);
      const dev = await connectUsbPrinterPeripheral();
      setHardwareDevice(dev);
      setHardwareBanner(`Connected ${dev.label} via WebUSB.`);
    } catch (err) {
      setHardwareBanner(err instanceof Error ? err.message : 'Could not pair USB printer.');
    }
  };

  const handleAuthorizedDrawerOpen = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!drawerPassword) {
      setDrawerAuthError('Enter an authorized pharmacist or owner password.');
      return;
    }
    setDrawerAuthBusy(true);
    setDrawerAuthError(null);
    const transport = hardwareDevice ? `${hardwareDevice.transport}_escpos` : 'system_counter';
    try {
      const res = await apiFetch<{
        ok: boolean;
        drawerAuthorized: boolean;
        event: CashDrawerEvent;
      }>('/api/staff/peripherals/drawer/open', {
        method: 'POST',
        body: JSON.stringify({
          password: drawerPassword,
          authorizerEmail: drawerAuthEmail.trim() || undefined,
          triggerType: drawerTrigger,
          reason: drawerReason.trim() || undefined,
          hardwareTransport: transport,
        }),
      });

      if (!res.drawerAuthorized) {
        throw new Error('Server rejected cash drawer unlock.');
      }

      if (hardwareDevice) {
        await sendCashDrawerKick(hardwareDevice);
        setHardwareBanner(
          `Cash drawer unlocked & kicked via ${hardwareDevice.label} (${res.event.actorName}).`
        );
      } else {
        setHardwareBanner(
          `Cash drawer unlock authorized by ${res.event.actorName}. Connect Serial/USB ESC/POS hardware in Printer/Drawer Setup to trigger physical RJ11 kick.`
        );
      }

      setDrawerRecentlyUnlocked(res.event.id);
      setTimeout(() => setDrawerRecentlyUnlocked(null), 5000);
      setDrawerPassword('');
      setDrawerReason('');
      setDrawerAuthEmail('');
      setPeripheralModal(null);
      await onSaleCompleted(`Authorized cash drawer access recorded (${res.event.actorName}).`);
    } catch (err) {
      setDrawerAuthError(err instanceof Error ? err.message : 'Authorization failed.');
    } finally {
      setDrawerAuthBusy(false);
    }
  };

  const handleDownloadReceipt = (r: PosReceipt) => {
    const lines = [
      'NETANYA PHARMACY & RETAIL SHOP · GHANA',
      'Your Health is Our Number One Priority',
      '----------------------------------------',
      `Receipt #: ${r.receiptNumber}`,
      `Date:      ${new Date(r.createdAt).toLocaleString('en-GH')}`,
      `Served by: ${r.cashierName}`,
      `Customer:  ${r.customerName}`,
      `Paid by:   ${r.paymentMethod === 'mobile_pay' ? 'MoMo / GhQR' : r.paymentMethod.toUpperCase()}`,
      '----------------------------------------',
      ...r.otcLines.map(
        (l) => `${l.quantity}x ${l.name} — ${formatMoney(l.unitPriceCents * l.quantity)}`
      ),
      ...(r.serviceLines || []).map(
        (s) => `Test: ${s.quantity}x ${s.name} — ${formatMoney(s.priceCents * s.quantity)}`
      ),
      ...r.rxLines.map(
        (rx) => `Rx ${rx.rxNumber} (${rx.medicationName}) — ${formatMoney(rx.copayCents)}`
      ),
      '----------------------------------------',
      `OTC Subtotal:       ${formatMoney(r.subtotalCents)}`,
      `Discount (${r.discountPercent}%):     -${formatMoney(r.discountCents)}`,
      `Retail VAT (15%):   ${formatMoney(r.taxCents)}`,
      `Tests & Services:   ${formatMoney(r.serviceTotalCents || 0)}`,
      `Rx Copay (Exempt):  ${formatMoney(r.rxCopayTotalCents)}`,
      `TOTAL PAID:         ${formatMoney(r.grandTotalCents)}`,
      `Tendered:           ${formatMoney(r.tenderedCents)}`,
      `Change Given:       ${formatMoney(r.changeDueCents)}`,
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${r.receiptNumber}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {/* Counter Hardware Peripherals Bar: Scanner, Authorized Cash Drawer & Receipt Printer */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <div className="inline-flex items-center gap-1.5 font-semibold text-slate-700">
            <Barcode className={`h-4 w-4 ${hidScannerEnabled ? 'text-emerald-600' : 'text-slate-400'}`} />
            <span>Scanner:</span>
            <button
              type="button"
              onClick={() => setHidScannerEnabled((v) => !v)}
              className={`rounded px-2 py-0.5 text-[11px] font-semibold border ${
                hidScannerEnabled
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-slate-200 bg-slate-50 text-slate-500'
              }`}
            >
              {hidScannerEnabled ? 'HID Ready' : 'HID Paused'}
            </button>
          </div>

          <span className="hidden sm:inline text-slate-300">|</span>

          <div className="inline-flex items-center gap-1.5 font-semibold text-slate-700">
            {drawerRecentlyUnlocked ? (
              <LockOpen className="h-4 w-4 text-emerald-600" />
            ) : (
              <Lock className="h-4 w-4 text-slate-600" />
            )}
            <span>Cash Drawer:</span>
            <span
              className={`font-mono text-[11px] font-bold ${
                drawerRecentlyUnlocked ? 'text-emerald-700' : 'text-slate-600'
              }`}
            >
              {drawerRecentlyUnlocked ? 'Unlocked' : 'Locked'}
            </span>
          </div>

          <span className="hidden sm:inline text-slate-300">|</span>

          <div className="inline-flex items-center gap-1.5 font-semibold text-slate-700">
            <Printer className={`h-4 w-4 ${hardwareDevice ? 'text-orange-600' : 'text-slate-500'}`} />
            <span>Printer:</span>
            <span className="text-[11px] text-slate-600">
              {hardwareDevice ? hardwareDevice.label : 'System 80mm / Text'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setPeripheralModal('camera_scan')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-orange-500"
          >
            <Camera className="h-3.5 w-3.5 text-orange-600" />
            Camera Scan
          </button>
          <button
            type="button"
            onClick={() => {
              setDrawerAuthError(null);
              setDrawerPassword('');
              setPeripheralModal('drawer_auth');
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100"
          >
            <KeyRound className="h-3.5 w-3.5" />
            Open Cash Drawer
          </button>
          <button
            type="button"
            onClick={() => setPeripheralModal('drawer_logs')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:border-slate-400"
          >
            <History className="h-3.5 w-3.5" />
            Drawer Log ({drawerEvents.length})
          </button>
          <button
            type="button"
            onClick={() => setPeripheralModal('hardware_setup')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
          >
            <Settings2 className="h-3.5 w-3.5" />
            Printer &amp; Drawer Setup
          </button>
        </div>
      </div>

      {hardwareBanner && (
        <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2 text-xs text-slate-700">
          <span>{hardwareBanner}</span>
          <button
            type="button"
            onClick={() => setHardwareBanner(null)}
            className="ml-3 font-semibold text-slate-500 hover:text-slate-900"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 items-start">
      {/* Left: Fast Counter Catalog, Pickups, Online Orders & Receipts */}
      <div className="rounded-xl border border-slate-200 bg-white lg:col-span-7 overflow-hidden">
        <div className="border-b border-slate-200 p-4 space-y-3">
          <form onSubmit={handleBarcodeSubmit} className="flex gap-2">
            <div className="relative flex-1">
              <Barcode className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Scan barcode or search medicine, item name, or Rx #..."
                className="w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 py-2 text-sm text-slate-900 focus:border-orange-500 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3.5 py-2 text-xs font-semibold text-slate-700 hover:border-orange-500 whitespace-nowrap"
            >
              <Search className="h-3.5 w-3.5" />
              Add
            </button>
          </form>

          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ['ALL', 'All Items'],
                ...activeCounterCategories.map((cat) => [cat, cat] as const),
                ['SERVICES', `Tests & Services (${activeServices.length})`],
                ['RX_PICKUP', `Ready Rx (${pickupPrescriptions.length})`],
                ['ONLINE_ORDERS', `Online Orders (${openOnlineOrders.length})`],
                ['RECEIPTS', `Receipts (${posReceipts.length})`],
              ] as Array<[CounterView, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setCounterView(key)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  counterView === key
                    ? 'bg-slate-900 text-white'
                    : 'border border-slate-200 bg-white text-slate-600 hover:border-orange-400 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-4">
          {counterView === 'SERVICES' ? (
            filteredServices.length === 0 ? (
              <p className="py-10 text-center text-xs text-slate-500">
                No pharmacy tests or services match your search.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {filteredServices.map((srv) => (
                  <button
                    key={srv.id}
                    type="button"
                    onClick={() => addServiceItem(srv)}
                    className="flex flex-col justify-between rounded-lg border border-slate-200 bg-white p-3.5 text-left transition-colors hover:border-orange-500 min-h-[88px]"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 font-semibold text-xs text-slate-900 leading-snug">
                        <Activity className="h-3.5 w-3.5 shrink-0 text-orange-600" />
                        {srv.name}
                      </span>
                      <span className="font-mono text-xs font-bold text-slate-900 tabular-nums shrink-0">
                        {formatMoney(srv.priceCents)}
                      </span>
                    </div>
                    <div className="mt-2.5 flex items-center justify-between text-[11px]">
                      <span className="text-slate-500">
                        {srv.category} · ~{srv.turnaroundMinutes}m
                      </span>
                      <span className="font-semibold text-orange-600">+ Add Test</span>
                    </div>
                  </button>
                ))}
              </div>
            )
          ) : counterView === 'RX_PICKUP' ? (
            filteredPickups.length === 0 ? (
              <p className="py-10 text-center text-xs text-slate-500">
                No prescriptions waiting for counter pickup right now.
              </p>
            ) : (
              <div className="divide-y divide-slate-100">
                {filteredPickups.map((rx) => {
                  const selected = ticketRxIds.includes(rx.id);
                  const payInfo = getRxPaymentInfo(rx);
                  return (
                    <button
                      key={rx.id}
                      type="button"
                      onClick={() => toggleRxPickup(rx)}
                      className={`flex w-full items-center justify-between gap-3 py-3 px-2 rounded-lg text-left transition-colors ${
                        selected ? 'bg-orange-50' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-xs">
                          <Pill className="h-3.5 w-3.5 shrink-0 text-orange-600" />
                          <span className="font-mono font-bold text-slate-900 tabular-nums">
                            {rx.rxNumber}
                          </span>
                          <span className="font-semibold text-slate-800">{rx.patientName}</span>
                        </div>
                        <p className="mt-0.5 text-xs text-slate-600 truncate">
                          {rx.medicationName} ·{' '}
                          {payInfo.coveredByInsurance
                            ? `${payInfo.payerName} copay`
                            : 'Cash / Self-Pay'}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-mono text-sm font-bold text-slate-900 tabular-nums">
                          {formatMoney(payInfo.copayCents)}
                        </p>
                        <p className="text-[11px] font-semibold text-orange-600">
                          {selected ? 'On Bill' : '+ Add to Bill'}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )
          ) : counterView === 'ONLINE_ORDERS' ? (
            recentOrders.length === 0 ? (
              <p className="py-10 text-center text-xs text-slate-500">
                No online shop orders yet.
              </p>
            ) : (
              <div className="divide-y divide-slate-100">
                {recentOrders.map((ord) => (
                  <div
                    key={ord.id}
                    className="flex flex-col justify-between gap-3 py-3 sm:flex-row sm:items-center"
                  >
                    <div className="min-w-0 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-slate-900 tabular-nums">
                          {ord.orderNumber}
                        </span>
                        <span className="font-semibold text-slate-800">{ord.customerName}</span>
                        <span
                          className={`font-semibold uppercase text-[11px] ${
                            ord.status === 'dispatched'
                              ? 'text-emerald-700'
                              : ord.status === 'ready_for_pickup'
                                ? 'text-orange-600'
                                : 'text-slate-600'
                          }`}
                        >
                          {ord.status.replace(/_/g, ' ')}
                        </span>
                      </div>
                      <p className="mt-0.5 text-slate-600">
                        {ord.items.map((it) => `${it.quantity}× ${it.name}`).join(', ')}
                      </p>
                      <p className="text-[11px] text-slate-500">{ord.shippingAddress}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-mono text-xs font-bold text-slate-900 tabular-nums mr-1">
                        {formatMoney(ord.totalCents)}
                      </span>
                      {ord.status !== 'ready_for_pickup' && ord.status !== 'dispatched' && (
                        <button
                          type="button"
                          onClick={() => onOrderStatusChange(ord.id, 'ready_for_pickup')}
                          className="rounded-md border border-orange-300 bg-orange-50 px-2.5 py-1.5 text-[11px] font-semibold text-orange-700 hover:bg-orange-100"
                        >
                          Mark Ready
                        </button>
                      )}
                      {ord.status !== 'dispatched' && (
                        <button
                          type="button"
                          onClick={() => onOrderStatusChange(ord.id, 'dispatched')}
                          className="rounded-md bg-slate-900 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-slate-800"
                        >
                          Handed Over
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : counterView === 'RECEIPTS' ? (
            posReceipts.length === 0 ? (
              <p className="py-10 text-center text-xs text-slate-500">
                No walk-in counter receipts saved yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 text-slate-500">
                    <tr>
                      <th className="py-2 font-semibold">Receipt #</th>
                      <th className="py-2 font-semibold">Customer</th>
                      <th className="py-2 font-semibold">Paid By</th>
                      <th className="py-2 font-semibold text-right">Total</th>
                      <th className="py-2 font-semibold text-right">Receipt</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {posReceipts.map((r) => (
                      <tr key={r.receiptNumber} className="hover:bg-slate-50">
                        <td className="py-2.5 font-mono font-bold text-slate-900 tabular-nums">
                          {r.receiptNumber}
                        </td>
                        <td className="py-2.5 text-slate-700">
                          {r.customerName}
                          <span className="ml-1.5 text-[11px] text-slate-400">
                            ({r.otcLines.length} OTC, {(r.serviceLines || []).length} Tests,{' '}
                            {r.rxLines.length} Rx)
                          </span>
                        </td>
                        <td className="py-2.5 font-mono uppercase text-[11px] text-slate-600">
                          {r.paymentMethod === 'mobile_pay' ? 'MoMo' : r.paymentMethod}
                        </td>
                        <td className="py-2.5 text-right font-mono font-bold text-slate-900 tabular-nums">
                          {formatMoney(r.grandTotalCents)}
                        </td>
                        <td className="py-2.5 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handlePrintReceipt(r, false)}
                              className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:border-orange-500 hover:text-orange-700"
                            >
                              <Printer className="h-3 w-3" />
                              Print
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDownloadReceipt(r)}
                              className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:border-orange-500 hover:text-orange-700"
                            >
                              <Download className="h-3 w-3" />
                              .txt
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : filteredItems.length === 0 ? (
            <p className="py-10 text-center text-xs text-slate-500">
              No counter items match your search.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {filteredItems.map((item) => {
                const out = item.stockQuantity <= 0;
                const low = item.stockQuantity <= item.reorderThreshold;
                return (
                  <div
                    key={item.id}
                    className={`flex flex-col justify-between rounded-lg border border-slate-200 bg-white transition-colors hover:border-orange-500 ${
                      out ? 'opacity-55' : ''
                    }`}
                  >
                    <button
                      type="button"
                      disabled={out}
                      onClick={() => addOtcItem(item)}
                      className="flex items-start gap-3 p-3 text-left flex-1 disabled:cursor-not-allowed"
                    >
                      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-slate-100 bg-white p-1 flex items-center justify-center">
                        {item.imageUrl ? (
                          <img
                            src={item.imageUrl}
                            alt={item.name}
                            className="h-full w-full object-contain"
                            loading="lazy"
                          />
                        ) : (
                          <Pill className="h-5 w-5 text-slate-300" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-semibold text-xs text-slate-900 leading-snug">
                            {item.name}
                          </span>
                          <span className="font-mono text-xs font-bold text-slate-900 tabular-nums shrink-0">
                            {formatMoney(item.unitPriceCents)}
                          </span>
                        </div>
                        {item.manufacturerName && (
                          <p className="mt-0.5 text-[11px] font-medium text-slate-500 truncate">
                            {item.manufacturerName}
                          </p>
                        )}
                      </div>
                    </button>
                    <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2 text-[11px]">
                      <span
                        className={`font-mono font-medium tabular-nums ${
                          out ? 'text-red-600' : low ? 'text-amber-700' : 'text-slate-500'
                        }`}
                      >
                        {out ? 'Out of stock' : `${item.stockQuantity} left`}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setSelectedInfoItem(item)}
                          className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-0.5 font-semibold text-slate-600 hover:border-orange-400 hover:text-orange-700"
                        >
                          <Info className="h-3 w-3" />
                          Info
                        </button>
                        <button
                          type="button"
                          disabled={out}
                          onClick={() => addOtcItem(item)}
                          className="font-semibold text-orange-600 hover:text-orange-700 disabled:text-slate-400"
                        >
                          + Add
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right: Current Walk-In Bill */}
      <div className="space-y-4 lg:col-span-5 lg:sticky lg:top-20">
        <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-200 pb-3">
            <div className="flex items-center gap-2">
              <Receipt className="h-4 w-4 text-orange-600" />
              <h2 className="font-display text-sm font-bold text-slate-900">Walk-In Bill</h2>
            </div>
            {hasBillLines && (
              <button
                type="button"
                onClick={() => {
                  setTicketOtc([]);
                  setTicketServices([]);
                  setTicketRxIds([]);
                }}
                className="text-xs font-semibold text-slate-500 hover:text-red-600"
              >
                Clear
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              type="text"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Customer Name"
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs focus:border-orange-500 focus:outline-none"
            />
            <input
              type="email"
              value={customerEmail}
              onChange={(e) => setCustomerEmail(e.target.value)}
              placeholder="Receipt email (optional)"
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs focus:border-orange-500 focus:outline-none"
            />
          </div>

          {!hasBillLines ? (
            <div className="rounded-lg border border-dashed border-slate-200 py-8 px-4 text-center text-xs text-slate-500">
              Tap any item, walk-in test, or ready prescription on the left to ring up a sale.
            </div>
          ) : (
            <div className="divide-y divide-slate-100 max-h-60 overflow-y-auto">
              {ticketOtc.map((line) => (
                <div
                  key={line.item.id}
                  className="flex items-center justify-between gap-2 py-2.5 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-slate-900 truncate">{line.item.name}</p>
                    <p className="font-mono text-[11px] text-slate-500 tabular-nums">
                      {formatMoney(line.item.unitPriceCents)} each
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => updateLineQty(line.item.id, -1)}
                      className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 text-slate-700 hover:bg-slate-50"
                      aria-label="Decrease quantity"
                    >
                      <Minus className="h-3 w-3" />
                    </button>
                    <span className="w-6 text-center font-mono font-bold tabular-nums">
                      {line.quantity}
                    </span>
                    <button
                      type="button"
                      onClick={() => updateLineQty(line.item.id, 1)}
                      className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 text-slate-700 hover:bg-slate-50"
                      aria-label="Increase quantity"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => updateLineQty(line.item.id, -99)}
                      className="ml-1 text-slate-400 hover:text-red-600"
                      aria-label="Remove item"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
              {ticketServices.map((sLine) => (
                <div
                  key={sLine.service.id}
                  className="flex items-center justify-between gap-2 py-2.5 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-slate-900 truncate">
                      Test · {sLine.service.name}
                    </p>
                    <p className="font-mono text-[11px] text-slate-500 tabular-nums">
                      {formatMoney(sLine.service.priceCents)} each (Exempt)
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => updateServiceQty(sLine.service.id, -1)}
                      className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 text-slate-700 hover:bg-slate-50"
                      aria-label="Decrease quantity"
                    >
                      <Minus className="h-3 w-3" />
                    </button>
                    <span className="w-6 text-center font-mono font-bold tabular-nums">
                      {sLine.quantity}
                    </span>
                    <button
                      type="button"
                      onClick={() => updateServiceQty(sLine.service.id, 1)}
                      className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 text-slate-700 hover:bg-slate-50"
                      aria-label="Increase quantity"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => updateServiceQty(sLine.service.id, -99)}
                      className="ml-1 text-slate-400 hover:text-red-600"
                      aria-label="Remove test"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
              {attachedPickups.map((rx) => (
                <div
                  key={rx.id}
                  className="flex items-center justify-between gap-2 py-2.5 text-xs"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-orange-700">Rx · {rx.rxNumber}</p>
                    <p className="text-[11px] text-slate-600 truncate">
                      {rx.medicationName} ({rx.patientName})
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono font-bold text-slate-900 tabular-nums">
                      {formatMoney(getRxPaymentInfo(rx).copayCents)}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleRxPickup(rx)}
                      className="text-slate-400 hover:text-red-600"
                      aria-label="Remove prescription"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Discount & Payment */}
          <div className="space-y-3 border-t border-slate-200 pt-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-700">OTC Discount</span>
              <div className="flex gap-1">
                {[0, 5, 10, 15].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => setDiscountPercent(pct)}
                    className={`rounded px-2 py-1 font-mono text-[11px] font-semibold ${
                      discountPercent === pct
                        ? 'bg-orange-600 text-white'
                        : 'border border-slate-200 text-slate-600'
                    }`}
                  >
                    {pct}%
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ['mobile_pay', 'MoMo / GhQR', Smartphone],
                  ['cash', 'Cash (GH₵)', Banknote],
                  ['card', 'Card / Gh-Link', CreditCard],
                ] as const
              ).map(([method, label, Icon]) => (
                <button
                  key={method}
                  type="button"
                  onClick={() => setPaymentMethod(method)}
                  className={`flex items-center justify-center gap-1.5 rounded-lg border py-2 px-1 text-xs font-semibold transition-colors ${
                    paymentMethod === method
                      ? 'border-orange-600 bg-orange-50 text-orange-700'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              ))}
            </div>

            {paymentMethod === 'cash' && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-semibold text-slate-700">Cash Given (GH₵)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={cashTenderDollars}
                    onChange={(e) => setCashTenderDollars(e.target.value)}
                    placeholder={(grandTotalCents / 100).toFixed(2)}
                    className="w-28 rounded border border-slate-300 bg-white px-2.5 py-1 text-right font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                  />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    ['Exact', (grandTotalCents / 100).toFixed(2)],
                    ['GH₵20', '20.00'],
                    ['GH₵50', '50.00'],
                    ['GH₵100', '100.00'],
                    ['GH₵200', '200.00'],
                  ].map(([label, val]) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setCashTenderDollars(val)}
                      className="rounded border border-slate-300 bg-white px-2 py-0.5 font-mono text-[11px] font-semibold text-slate-700 hover:border-orange-500"
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="flex justify-between text-xs font-bold text-emerald-700">
                  <span>Change to Give</span>
                  <span className="font-mono tabular-nums">{formatMoney(changeDueCents)}</span>
                </div>
              </div>
            )}

            {paymentMethod === 'mobile_pay' && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
                <div className="grid grid-cols-[1fr_110px] gap-2">
                  <input
                    type="tel"
                    value={momoPhone}
                    onChange={(e) => setMomoPhone(e.target.value)}
                    placeholder="Customer MoMo number (e.g. 024 123 4567)"
                    autoComplete="off"
                    className="rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs focus:border-orange-500 focus:outline-none"
                  />
                  <select
                    value={momoProvider}
                    onChange={(e) => setMomoProvider(e.target.value as 'mtn' | 'atl' | 'vod')}
                    className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs font-semibold focus:border-orange-500 focus:outline-none"
                  >
                    <option value="mtn">MTN</option>
                    <option value="vod">Telecel</option>
                    <option value="atl">AirtelTigo</option>
                  </select>
                </div>
                <button
                  type="button"
                  onClick={handleSendMomoPrompt}
                  disabled={momoSending || !hasBillLines || Boolean(momoRequest && ['pending', 'pay_offline', 'send_otp'].includes(momoRequest.status))}
                  className="w-full rounded-lg border border-orange-600 bg-white py-2 text-xs font-semibold text-orange-700 hover:bg-orange-50 disabled:opacity-45 transition-colors"
                >
                  {momoSending
                    ? 'Sending prompt...'
                    : momoRequest && ['pending', 'pay_offline', 'send_otp'].includes(momoRequest.status)
                      ? 'Waiting for customer approval...'
                      : `Send MoMo Prompt (${formatMoney(grandTotalCents)})`}
                </button>
                {momoRequest && (
                  <p
                    className={`text-[11px] font-semibold ${
                      momoRequest.status === 'success'
                        ? 'text-emerald-700'
                        : ['failed', 'expired', 'superseded', 'abandoned'].includes(momoRequest.status)
                          ? 'text-red-600'
                          : 'text-slate-500'
                    }`}
                  >
                    {momoRequest.status === 'success'
                      ? `Payment confirmed — reference ${momoRequest.reference}`
                      : ['failed', 'expired', 'superseded', 'abandoned'].includes(momoRequest.status)
                        ? `Payment ${momoRequest.status} — send a new prompt to retry.`
                        : 'Prompt sent — customer must approve on their phone within ~3 minutes.'}
                  </p>
                )}
              </div>
            )}

            {paymentMethod === 'card' && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-1.5">
                <label className="text-xs font-semibold text-slate-700">
                  Paystack Payment Reference
                </label>
                <input
                  type="text"
                  value={paymentReference}
                  onChange={(e) => setPaymentReference(e.target.value)}
                  placeholder="e.g. 7b8f9c2d-…"
                  autoComplete="off"
                  className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs focus:border-orange-500 focus:outline-none"
                />
                <p className="text-[11px] text-slate-500">
                  Verified server-side — the paid amount must equal {formatMoney(grandTotalCents)}.
                </p>
              </div>
            )}

            <div className="space-y-1.5 border-t border-slate-200 pt-3 text-xs">
              <div className="flex justify-between text-slate-600">
                <span>OTC Items</span>
                <span className="font-mono tabular-nums">{formatMoney(otcSubtotalCents)}</span>
              </div>
              {discountCents > 0 && (
                <div className="flex justify-between text-emerald-700">
                  <span>Discount ({discountPercent}%)</span>
                  <span className="font-mono tabular-nums">-{formatMoney(discountCents)}</span>
                </div>
              )}
              <div className="flex justify-between text-slate-600">
                <span>VAT (15% · Rx Exempt)</span>
                <span className="font-mono tabular-nums">{formatMoney(taxCents)}</span>
              </div>
              {serviceTotalCents > 0 && (
                <div className="flex justify-between text-slate-600">
                  <span>Tests &amp; Services (Exempt)</span>
                  <span className="font-mono tabular-nums">{formatMoney(serviceTotalCents)}</span>
                </div>
              )}
              {rxCopayTotalCents > 0 && (
                <div className="flex justify-between text-slate-600">
                  <span>Prescription Copay ({attachedPickups.length})</span>
                  <span className="font-mono tabular-nums">{formatMoney(rxCopayTotalCents)}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-bold text-slate-900">
                <span>Total Due</span>
                <span className="font-mono text-orange-600 tabular-nums">
                  {formatMoney(grandTotalCents)}
                </span>
              </div>
            </div>

            {error && <p className="text-xs font-semibold text-red-600">{error}</p>}

            <button
              type="button"
              disabled={busy || !hasBillLines}
              onClick={handleCheckout}
              className="w-full rounded-lg bg-orange-600 py-3 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-45 transition-colors min-h-[44px]"
            >
              {busy ? 'Saving Sale...' : `Collect ${formatMoney(grandTotalCents)}`}
            </button>
          </div>
        </div>

        {lastReceipt && (
          <div className="rounded-xl border border-emerald-300 bg-emerald-50/70 p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-emerald-800">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span className="font-mono text-xs font-bold tabular-nums">
                  {lastReceipt.receiptNumber} · Paid (
                  {lastReceipt.paymentMethod === 'mobile_pay'
                    ? 'MoMo / GhQR'
                    : lastReceipt.paymentMethod.toUpperCase()}
                  )
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handlePrintReceipt(lastReceipt, false)}
                  className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-white px-2.5 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                >
                  <Printer className="h-3 w-3" />
                  Print
                </button>
                <button
                  type="button"
                  onClick={() => handleDownloadReceipt(lastReceipt)}
                  className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-white px-2.5 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                >
                  <Download className="h-3 w-3" />
                  .txt
                </button>
              </div>
            </div>
            <p className="text-xs text-emerald-950">
              {lastReceipt.customerName} ·{' '}
              <strong className="font-mono tabular-nums">
                {formatMoney(lastReceipt.grandTotalCents)}
              </strong>
              {lastReceipt.changeDueCents > 0 && (
                <>
                  {' '}
                  · Change:{' '}
                  <strong className="font-mono tabular-nums">
                    {formatMoney(lastReceipt.changeDueCents)}
                  </strong>
                </>
              )}
            </p>
            {lastReceipt.poTriggered && (
              <p className="text-xs font-semibold text-amber-900">
                Low stock triggered an automatic supplier restock order.
              </p>
            )}
          </div>
        )}
      </div>

      </div>

      {/* Hardware Peripherals Modals */}
      {peripheralModal === 'hardware_setup' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-xs"
          onClick={() => setPeripheralModal(null)}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-slate-200 pb-3">
              <div>
                <h3 className="font-display text-base font-bold text-slate-900">
                  Counter Hardware Setup
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Connect thermal receipt printer (80mm ESC/POS), RJ11 electronic cash drawer, and
                  barcode scanner settings.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPeripheralModal(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-800">Active Printer / Drawer Link</span>
                <span className="font-mono font-bold text-slate-900">
                  {hardwareDevice ? hardwareDevice.label : 'System 80mm Print Driver'}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <label className="text-[11px] font-semibold text-slate-600">
                  Serial Baud Rate:
                </label>
                <select
                  value={serialBaudRate}
                  onChange={(e) => setSerialBaudRate(Number(e.target.value))}
                  className="rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[11px]"
                >
                  {[9600, 19200, 38400, 115200].map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!isWebSerialSupported()}
                  onClick={handleConnectSerial}
                  className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-45"
                >
                  <Usb className="h-3.5 w-3.5" />
                  Connect Serial Port
                </button>
                <button
                  type="button"
                  disabled={!isWebUsbSupported()}
                  onClick={handleConnectUsb}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-orange-500 disabled:opacity-45"
                >
                  <Usb className="h-3.5 w-3.5" />
                  Connect USB Printer
                </button>
                {hardwareDevice && (
                  <button
                    type="button"
                    onClick={async () => {
                      await disconnectPeripheral(hardwareDevice);
                      setHardwareDevice(null);
                      setHardwareBanner('Disconnected external Serial/USB device.');
                    }}
                    className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700"
                  >
                    Disconnect
                  </button>
                )}
              </div>
              {(!isWebSerialSupported() || !isWebUsbSupported()) && (
                <p className="text-[11px] text-slate-500">
                  Direct Web Serial/USB requires Chrome or Edge over HTTPS. System 80mm thermal
                  printing works in all browsers.
                </p>
              )}
            </div>

            <div className="space-y-2 text-xs">
              <label className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 cursor-pointer">
                <span className="font-semibold text-slate-800">
                  Auto-print receipt after completing sale
                </span>
                <input
                  type="checkbox"
                  checked={autoPrintOnSale}
                  onChange={(e) => setAutoPrintOnSale(e.target.checked)}
                  className="h-4 w-4 accent-orange-600"
                />
              </label>
              <label className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 cursor-pointer">
                <span className="font-semibold text-slate-800">
                  Auto-kick cash drawer on Cash (GH₵) sales only
                </span>
                <input
                  type="checkbox"
                  checked={autoKickDrawerOnCash}
                  onChange={(e) => setAutoKickDrawerOnCash(e.target.checked)}
                  className="h-4 w-4 accent-orange-600"
                />
              </label>
              <label className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 cursor-pointer">
                <span className="font-semibold text-slate-800">
                  Global USB/Bluetooth HID barcode scanner capture
                </span>
                <input
                  type="checkbox"
                  checked={hidScannerEnabled}
                  onChange={(e) => setHidScannerEnabled(e.target.checked)}
                  className="h-4 w-4 accent-orange-600"
                />
              </label>
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 pt-3">
              <button
                type="button"
                onClick={() =>
                  handlePrintReceipt(
                    {
                      receiptNumber: 'TEST-80MM',
                      customerName: 'Hardware Self-Test',
                      cashierName,
                      paymentMethod: 'cash',
                      discountPercent: 0,
                      otcLines: [
                        {
                          inventoryId: 'test',
                          name: 'Panadol Advance 500mg (Sample Line)',
                          quantity: 1,
                          unitPriceCents: 1800,
                        },
                      ],
                      rxLines: [],
                      serviceLines: [],
                      subtotalCents: 1800,
                      discountCents: 0,
                      taxCents: 270,
                      rxCopayTotalCents: 0,
                      serviceTotalCents: 0,
                      grandTotalCents: 2070,
                      tenderedCents: 2070,
                      changeDueCents: 0,
                      poTriggered: false,
                      createdAt: new Date().toISOString(),
                    },
                    false
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-orange-500"
              >
                <Printer className="h-3.5 w-3.5" />
                Print Test Slip
              </button>
              <button
                type="button"
                onClick={() => setPeripheralModal(null)}
                className="rounded-lg bg-orange-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-orange-700"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {peripheralModal === 'camera_scan' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-xs"
          onClick={() => setPeripheralModal(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2">
                <Camera className="h-4 w-4 text-orange-600" />
                <h3 className="font-display text-sm font-bold text-slate-900">
                  Camera Barcode Scanner
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setPeripheralModal(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-950 aspect-video flex items-center justify-center">
              {cameraError ? (
                <p className="p-4 text-center text-xs text-slate-200">{cameraError}</p>
              ) : (
                <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
              )}
            </div>
            <p className="text-[11px] text-slate-500">
              Hold a medicine barcode (EAN-13, UPC, Code-128) or prescription QR code in front of
              the lens to add it directly to the bill.
            </p>
          </div>
        </div>
      )}

      {peripheralModal === 'drawer_auth' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-xs"
          onClick={() => setPeripheralModal(null)}
        >
          <form
            onSubmit={handleAuthorizedDrawerOpen}
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl space-y-3.5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4 text-amber-600" />
                <div>
                  <h3 className="font-display text-sm font-bold text-slate-900">
                    Authorize Cash Drawer Open
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Signed in as {cashierName} ({cashierRole}). Password verification required.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPeripheralModal(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">Reason</label>
              <select
                value={drawerTrigger}
                onChange={(e) => setDrawerTrigger(e.target.value as CashDrawerTrigger)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
              >
                <option value="manual_no_sale">No-Sale Change / Till Check</option>
                <option value="shift_count">Shift Cash Count / Closeout</option>
                <option value="cash_drop">Cash Drop to Safe</option>
                <option value="refund">Authorized Customer Cash Refund</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">
                Notes (optional)
              </label>
              <input
                type="text"
                value={drawerReason}
                onChange={(e) => setDrawerReason(e.target.value)}
                placeholder="e.g. Making change for GH₵200 note"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">
                Supervisor / Different Staff Email (optional override)
              </label>
              <input
                type="email"
                value={drawerAuthEmail}
                onChange={(e) => setDrawerAuthEmail(e.target.value)}
                placeholder="Leave blank to authorize as current signed-in user"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">
                Authorized Password
              </label>
              <input
                type="password"
                required
                autoFocus
                value={drawerPassword}
                onChange={(e) => setDrawerPassword(e.target.value)}
                placeholder="Enter pharmacist or owner password"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
              />
            </div>

            {drawerAuthError && (
              <p className="text-xs font-semibold text-red-600">{drawerAuthError}</p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPeripheralModal(null)}
                className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-semibold text-slate-600"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={drawerAuthBusy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
              >
                <LockOpen className="h-3.5 w-3.5" />
                {drawerAuthBusy ? 'Verifying...' : 'Unlock & Open Drawer'}
              </button>
            </div>
          </form>
        </div>
      )}

      {peripheralModal === 'drawer_logs' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-xs"
          onClick={() => setPeripheralModal(null)}
        >
          <div
            className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h3 className="font-display text-base font-bold text-slate-900">
                  Authorized Cash Drawer Log
                </h3>
                <p className="text-xs text-slate-500">
                  Every cash drawer opening requires an authorized cash checkout or staff/owner
                  password check.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPeripheralModal(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {drawerEvents.length === 0 ? (
              <p className="py-8 text-center text-xs text-slate-500">
                No cash drawer openings recorded yet.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 text-xs">
                {drawerEvents.map((ev) => (
                  <div
                    key={ev.id}
                    className="flex flex-col justify-between gap-1 py-2.5 sm:flex-row sm:items-center"
                  >
                    <div>
                      <p className="font-semibold text-slate-900">
                        {ev.actorName}{' '}
                        <span className="font-mono text-[11px] uppercase text-slate-500">
                          ({ev.actorRole})
                        </span>
                      </p>
                      <p className="text-slate-600">{ev.reason}</p>
                    </div>
                    <div className="text-left sm:text-right font-mono text-[11px] text-slate-500 tabular-nums">
                      <div className="uppercase">{ev.triggerType.replace(/_/g, ' ')}</div>
                      <div>{new Date(ev.authorizedAt).toLocaleString('en-GH')}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {selectedInfoItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-xs"
          onClick={() => setSelectedInfoItem(null)}
        >
          <div
            className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-4">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-orange-600">
                  {selectedInfoItem.manufacturerName || selectedInfoItem.category}
                </p>
                <h3 className="mt-0.5 font-display text-base font-bold text-slate-900">
                  {selectedInfoItem.name}
                </h3>
                <p className="mt-1 font-mono text-xs text-slate-500 tabular-nums">
                  {formatMoney(selectedInfoItem.unitPriceCents)} · {selectedInfoItem.stockQuantity} in
                  stock · Code {selectedInfoItem.ndcCode}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedInfoItem(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close product info"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-12">
              <div className="sm:col-span-4">
                <div className="aspect-square overflow-hidden rounded-xl border border-slate-200 bg-white p-3 flex items-center justify-center">
                  {selectedInfoItem.imageUrl ? (
                    <img
                      src={selectedInfoItem.imageUrl}
                      alt={selectedInfoItem.name}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <Pill className="h-10 w-10 text-slate-300" />
                  )}
                </div>
              </div>
              <div className="space-y-2.5 text-xs sm:col-span-8">
                {selectedInfoItem.activeIngredient && (
                  <div>
                    <span className="font-semibold text-slate-800">Active Ingredients: </span>
                    <span className="text-slate-600">{selectedInfoItem.activeIngredient}</span>
                  </div>
                )}
                {selectedInfoItem.dosageForm && (
                  <div>
                    <span className="font-semibold text-slate-800">Pack &amp; Form: </span>
                    <span className="text-slate-600">{selectedInfoItem.dosageForm}</span>
                  </div>
                )}
                {selectedInfoItem.description && (
                  <div>
                    <span className="font-semibold text-slate-800">Uses: </span>
                    <span className="text-slate-600">{selectedInfoItem.description}</span>
                  </div>
                )}
                {selectedInfoItem.usageDirections && (
                  <div className="rounded-lg bg-slate-50 border border-slate-200 p-2.5">
                    <p className="font-semibold text-slate-900">Directions</p>
                    <p className="mt-1 text-slate-700 leading-relaxed">
                      {selectedInfoItem.usageDirections}
                    </p>
                  </div>
                )}
                {selectedInfoItem.warnings && (
                  <div className="rounded-lg bg-amber-50/80 border border-amber-200 p-2.5">
                    <p className="flex items-center gap-1 font-semibold text-amber-900">
                      <ShieldAlert className="h-3.5 w-3.5" />
                      Safety Warnings
                    </p>
                    <p className="mt-1 text-amber-950 leading-relaxed">
                      {selectedInfoItem.warnings}
                    </p>
                  </div>
                )}
                {selectedInfoItem.storageInfo && (
                  <div>
                    <span className="font-semibold text-slate-800">Storage: </span>
                    <span className="text-slate-600">{selectedInfoItem.storageInfo}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-3">
              {selectedInfoItem.officialSourceUrl ? (
                <a
                  href={selectedInfoItem.officialSourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-semibold text-slate-600 hover:text-orange-700"
                >
                  Official Manufacturer Label
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedInfoItem(null)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600"
                >
                  Close
                </button>
                <button
                  type="button"
                  disabled={selectedInfoItem.stockQuantity <= 0}
                  onClick={() => {
                    addOtcItem(selectedInfoItem);
                    setSelectedInfoItem(null);
                  }}
                  className="rounded-lg bg-orange-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-orange-700 disabled:opacity-45"
                >
                  Add to Bill
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
