import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { adjudicateClaim, type AdjudicationInput } from './server/claimEngine.ts';
import { db, initializeDatabase, nextSequence } from './server/db.ts';
import {
  decryptPHI,
  encryptPHI,
  hashPassword,
  type SessionPayload,
  signSessionToken,
  verifyPassword,
  verifySessionToken,
} from './server/security.ts';
import {
  INVENTORY_CATEGORIES,
  type CashDrawerEvent,
  type CashDrawerTrigger,
  type InventoryCategory,
  type InventoryItem,
  type NcpdpRejectionCode,
  type OfficialDrugLookupResult,
  type OtcOrderItem,
  type PatientPHI,
  type PharmacyService,
  type PublicInventoryItem,
  type PrescriptionStatus,
  type ReplenishmentStatus,
  type ServiceLog,
  type UserRole,
} from './src/types.ts';

dotenv.config();
initializeDatabase();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else if (pathname !== '/vite-hmr') {
    socket.destroy();
  }
});

interface AuthedSocket {
  ws: WebSocket;
  user: SessionPayload | null;
}

const clients = new Set<AuthedSocket>();

function getCurrentSession(token: string): SessionPayload | null {
  const session = verifySessionToken(token);
  if (!session) return null;

  const account = db
    .prepare('SELECT role, email, display_name FROM users WHERE id = ?')
    .get(session.uid) as
    | { role: UserRole; email: string; display_name: string }
    | undefined;
  if (!account || account.role !== session.role) return null;

  return {
    ...session,
    role: account.role,
    email: account.email,
    displayName: account.display_name,
  };
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/ws', 'http://localhost');
  const token = url.searchParams.get('token') || '';
  const user = getCurrentSession(token);
  const client: AuthedSocket = { ws, user };
  clients.add(client);

  ws.send(
    JSON.stringify({
      type: 'connected',
      authenticated: Boolean(user),
      role: user?.role || null,
    })
  );

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw)) as { type?: string; token?: string };
      if (msg.type === 'auth' && typeof msg.token === 'string') {
        client.user = getCurrentSession(msg.token);
      }
    } catch {
      // Ignore malformed client frames
    }
  });

  ws.on('close', () => {
    clients.delete(client);
  });
});

function broadcastTopics(topics: string[], targetUserId?: string): void {
  const payload = JSON.stringify({ type: 'sync', topics, timestamp: Date.now() });
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (client.user) {
      const account = db
        .prepare('SELECT role FROM users WHERE id = ?')
        .get(client.user.uid) as { role: UserRole } | undefined;
      if (!account || account.role !== client.user.role) {
        client.ws.close(1008, 'Session is no longer valid.');
        clients.delete(client);
        continue;
      }
    }
    if (targetUserId && client.user?.uid !== targetUserId) {
      continue;
    }
    client.ws.send(payload);
  }
}

function runTx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function validateConfirmedQuantity(quantity: unknown, requestedQuantity: unknown): number {
  const confirmed = Number(quantity);
  const requested = Number(requestedQuantity);
  if (
    !Number.isSafeInteger(requested) ||
    requested < 1 ||
    !Number.isSafeInteger(confirmed) ||
    confirmed < 1 ||
    confirmed > requested
  ) {
    throw new Error('Confirmed quantity must be a positive whole number no greater than the quantity ordered.');
  }
  return confirmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFormularyTier(value: unknown): value is AdjudicationInput['formularyTier'] {
  return value === 1 || value === 2 || value === 3;
}

function isDawCode(value: unknown): value is AdjudicationInput['dawCode'] {
  return value === '0' || value === '1' || value === '2';
}

interface PaystackPayment {
  reference: string;
  amountCents: number;
}

interface PaystackTransaction {
  reference: string;
  status: string;
  amountCents: number;
  currency: string;
}

async function fetchPaystackTransaction(reference: string): Promise<PaystackTransaction> {
  const secret = process.env.PAYSTACK_SECRET_KEY?.trim();
  if (!secret) {
    throw new Error('Online payment is not configured.');
  }
  if (!reference) {
    throw new Error('A successful payment reference is required.');
  }

  const response = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10_000),
    }
  );
  const payload = await response.json() as {
    status?: boolean;
    message?: string;
    data?: { status?: string; amount?: number; currency?: string; reference?: string };
  };
  if (!response.ok || !payload.status || !payload.data) {
    throw new Error(payload.message || 'Payment verification failed.');
  }
  const payment = payload.data;
  if (payment.reference !== reference || typeof payment.amount !== 'number') {
    throw new Error('Payment verification failed.');
  }
  return {
    reference,
    status: String(payment.status || ''),
    amountCents: Number(payment.amount),
    currency: String(payment.currency || ''),
  };
}

async function fetchPaystackPayment(reference: string): Promise<PaystackPayment> {
  const payment = await fetchPaystackTransaction(reference);
  if (payment.status !== 'success' || payment.currency !== 'GHS') {
    throw new Error('Payment was not successful or does not match the order total.');
  }
  return { reference: payment.reference, amountCents: payment.amountCents };
}

async function verifyPaystackPayment(reference: string, expectedAmountCents?: number): Promise<void> {
  const payment = await fetchPaystackPayment(reference);
  if (expectedAmountCents !== undefined && payment.amountCents !== expectedAmountCents) {
    throw new Error('Payment was not successful or does not match the order total.');
  }
}

// Only absolute https URLs are safe to render as links in the public storefront.
function sanitizeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function writeAuditLog(
  actorId: string,
  actorName: string,
  actorRole: UserRole | 'public',
  action: string,
  resourceType: string,
  resourceId: string,
  summary: string
): void {
  db.prepare(
    `INSERT INTO audit_logs (id, actor_id, actor_name, actor_role, action, resource_type, resource_id, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `aud_${crypto.randomUUID().slice(0, 8)}`,
    actorId,
    actorName,
    actorRole,
    action,
    resourceType,
    resourceId,
    summary,
    new Date().toISOString()
  );
}

function checkAndTriggerAutoReplenishment(inventoryId: string, actorId: string, actorName: string, actorRole: UserRole | 'public'): boolean {
  const item = db
    .prepare('SELECT * FROM inventory WHERE id = ?')
    .get(inventoryId) as Record<string, unknown> | undefined;
  if (!item) return false;
  const stock = Number(item.stock_quantity);
  const threshold = Number(item.reorder_threshold);
  const autoEnabled = Number(item.auto_reorder_enabled) === 1;
  if (!autoEnabled || stock > threshold) return false;

  const existingOpenPo = db
    .prepare(
      `SELECT id FROM replenishment_orders WHERE inventory_id = ? AND status IN ('awaiting_supplier','confirmed_scheduled','in_transit')`
    )
    .get(inventoryId);
  if (existingOpenPo) return false;

  const now = new Date().toISOString();
  const poId = `po_${crypto.randomUUID().slice(0, 8)}`;
  const poNum = `PO-AUTO-${nextSequence('po_seq', 3002)}`;
  db.prepare(
    `INSERT INTO replenishment_orders (
      id, po_number, inventory_id, medication_name, ndc_code, supplier_id, supplier_name,
      requested_qty, status, auto_triggered, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_supplier', 1, ?, ?)`
  ).run(
    poId,
    poNum,
    String(item.id),
    String(item.name),
    String(item.ndc_code),
    String(item.supplier_id),
    String(item.supplier_name),
    Number(item.reorder_quantity),
    now,
    now
  );

  writeAuditLog(
    actorId,
    actorName,
    actorRole,
    'AUTO_REPLENISHMENT_TRIGGERED',
    'replenishment_orders',
    poId,
    `${String(item.name)} dropped to ${stock}/${threshold}; auto-dispatched ${poNum} to ${String(item.supplier_name)}.`
  );
  return true;
}

function mapInventoryRow(row: Record<string, unknown>): InventoryItem {
  return {
    id: String(row.id),
    ndcCode: String(row.ndc_code),
    name: String(row.name),
    category: row.category as InventoryItem['category'],
    description: String(row.description),
    imageUrl: row.image_url ? String(row.image_url) : null,
    manufacturerName: row.manufacturer_name ? String(row.manufacturer_name) : '',
    activeIngredient: row.active_ingredient ? String(row.active_ingredient) : '',
    dosageForm: row.dosage_form ? String(row.dosage_form) : '',
    usageDirections: row.usage_directions ? String(row.usage_directions) : '',
    warnings: row.warnings ? String(row.warnings) : '',
    storageInfo: row.storage_info ? String(row.storage_info) : '',
    officialSourceUrl: row.official_source_url ? String(row.official_source_url) : null,
    unitPriceCents: Number(row.unit_price_cents),
    costPriceCents: Number(row.cost_price_cents),
    stockQuantity: Number(row.stock_quantity),
    reorderThreshold: Number(row.reorder_threshold),
    reorderQuantity: Number(row.reorder_quantity),
    lotNumber: String(row.lot_number),
    expiryDate: String(row.expiry_date),
    supplierId: String(row.supplier_id),
    supplierName: String(row.supplier_name),
    autoReorderEnabled: Number(row.auto_reorder_enabled) === 1,
    requiresPrescription: Number(row.requires_prescription) === 1,
  };
}

function mapPublicInventoryRow(row: Record<string, unknown>): PublicInventoryItem {
  return {
    id: String(row.id),
    ndcCode: String(row.ndc_code),
    name: String(row.name),
    category: row.category as InventoryCategory,
    description: String(row.description),
    imageUrl: row.image_url ? String(row.image_url) : null,
    manufacturerName: row.manufacturer_name ? String(row.manufacturer_name) : '',
    activeIngredient: row.active_ingredient ? String(row.active_ingredient) : '',
    dosageForm: row.dosage_form ? String(row.dosage_form) : '',
    usageDirections: row.usage_directions ? String(row.usage_directions) : '',
    warnings: row.warnings ? String(row.warnings) : '',
    storageInfo: row.storage_info ? String(row.storage_info) : '',
    officialSourceUrl: row.official_source_url ? String(row.official_source_url) : null,
    unitPriceCents: Number(row.unit_price_cents),
    inStock: Number(row.stock_quantity) > 0,
  };
}

function getDispensingClaim(rx: Record<string, unknown>): Record<string, unknown> | undefined {
  if (rx.status === 'dispensed') {
    throw new Error(`${String(rx.rx_number)} is already dispensed.`);
  }
  if (rx.status !== 'ready') {
    throw new Error(`${String(rx.rx_number)} must be verified and marked ready before dispensing.`);
  }
  const claim = db
    .prepare('SELECT * FROM insurance_claims WHERE prescription_id = ?')
    .get(String(rx.id)) as Record<string, unknown> | undefined;
  if (claim && claim.claim_status !== 'adjudicated' && claim.claim_status !== 'paid') {
    throw new Error(`${String(rx.rx_number)} has no approved insurance claim.`);
  }
  return claim;
}

function mapServiceRow(row: Record<string, unknown>): PharmacyService {
  return {
    id: String(row.id),
    name: String(row.name),
    category: String(row.category),
    turnaroundMinutes: Number(row.turnaround_minutes),
    priceCents: Number(row.price_cents),
    notes: String(row.notes),
    active: Number(row.active) === 1,
  };
}

function mapServiceLogRow(row: Record<string, unknown>): ServiceLog {
  return {
    id: String(row.id),
    serviceId: String(row.service_id),
    serviceName: String(row.service_name),
    patientName: String(row.patient_name),
    resultValue: String(row.result_value),
    notes: String(row.notes),
    priceCents: Number(row.price_cents),
    recordedBy: String(row.recorded_by),
    createdAt: String(row.created_at),
  };
}

function mapDrawerEventRow(row: Record<string, unknown>): CashDrawerEvent {
  return {
    id: String(row.id),
    actorId: String(row.actor_id),
    actorName: String(row.actor_name),
    actorRole: row.actor_role as UserRole,
    triggerType: row.trigger_type as CashDrawerTrigger,
    reason: String(row.reason),
    receiptNumber: row.receipt_number ? String(row.receipt_number) : null,
    hardwareTransport: String(row.hardware_transport),
    authorizedAt: String(row.authorized_at),
  };
}

function recordCashDrawerEvent(params: {
  actorId: string;
  actorName: string;
  actorRole: UserRole;
  triggerType: CashDrawerTrigger;
  reason: string;
  receiptNumber?: string | null;
  hardwareTransport: string;
  authorizedAt?: string;
}): CashDrawerEvent {
  const id = `drw_${crypto.randomUUID().slice(0, 8)}`;
  const authorizedAt = params.authorizedAt || new Date().toISOString();
  db.prepare(
    `INSERT INTO cash_drawer_events (
      id, actor_id, actor_name, actor_role, trigger_type, reason, receipt_number, hardware_transport, authorized_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.actorId,
    params.actorName,
    params.actorRole,
    params.triggerType,
    params.reason,
    params.receiptNumber || null,
    params.hardwareTransport,
    authorizedAt
  );
  return {
    id,
    actorId: params.actorId,
    actorName: params.actorName,
    actorRole: params.actorRole,
    triggerType: params.triggerType,
    reason: params.reason,
    receiptNumber: params.receiptNumber || null,
    hardwareTransport: params.hardwareTransport,
    authorizedAt,
  };
}

interface AuthedRequest extends Request {
  user?: SessionPayload;
  params: Record<string, string>;
}

app.use(express.json({ limit: '1mb' }));

// Security & Privacy headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use('/api/patient', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api/staff', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api/owner', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Fixed-window in-memory rate limiter for unauthenticated surfaces.
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(name: string, maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    if (rateBuckets.size > 10000) {
      for (const [k, b] of rateBuckets) {
        if (b.resetAt <= now) rateBuckets.delete(k);
      }
    }
    const key = `${name}|${req.ip || 'unknown'}`;
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    if (bucket.count >= maxRequests) {
      res.status(429).json({ error: 'Too many requests. Please try again later.' });
      return;
    }
    bucket.count += 1;
    next();
  };
}

app.use('/api/public/payments/initialize', rateLimit('pay-init', 10, 60_000));
app.use('/api/public/orders', rateLimit('public-orders', 20, 60_000));
app.use('/api/public', rateLimit('public', 60, 60_000));
app.use('/api/auth/login', rateLimit('auth-login', 10, 60_000));
app.use('/api/auth/register', rateLimit('auth-register', 10, 60_000));

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const session = getCurrentSession(token);
  if (!session) {
    res.status(401).json({ error: 'Session is no longer valid. Please sign in again.' });
    return;
  }
  req.user = session;
  next();
}

function requireRole(...roles: UserRole[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        error: `Access denied. Portal restricted to: ${roles.join(', ')}.`,
      });
      return;
    }
    next();
  };
}

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'NETANYA PHARMACY & RETAIL SHOP', timestamp: new Date().toISOString() });
});

// Public catalog (no PHI)
app.get('/api/public/catalog', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, ndc_code, name, category, description, image_url, manufacturer_name,
        active_ingredient, dosage_form, usage_directions, warnings, storage_info,
        official_source_url, unit_price_cents, stock_quantity
       FROM inventory WHERE requires_prescription = 0 ORDER BY category, name`
    )
    .all() as Record<string, unknown>[];
  const plans = db
    .prepare('SELECT id, payer_name, bin, pcn, group_prefix FROM insurance_plans ORDER BY payer_name')
    .all() as Record<string, unknown>[];
  const serviceRows = db
    .prepare('SELECT * FROM pharmacy_services WHERE active = 1 ORDER BY category, name')
    .all() as Record<string, unknown>[];
  res.json({
    items: rows.map(mapPublicInventoryRow),
    services: serviceRows.map(mapServiceRow),
    acceptedPlans: plans.map((p) => ({
      id: String(p.id),
      payerName: String(p.payer_name),
      bin: String(p.bin),
      pcn: String(p.pcn),
      groupPrefix: String(p.group_prefix),
    })),
  });
});

// Public / Patient OTC payment initialization
app.post('/api/public/payments/initialize', async (req: AuthedRequest, res) => {
  const { customerEmail, items, callbackUrl } = req.body as {
    customerEmail?: string;
    items?: Array<{ inventoryId: string; quantity: number }>;
    callbackUrl?: string;
  };

  if (!customerEmail || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'Receipt email and at least one retail item are required.' });
    return;
  }

  try {
    let subtotalCents = 0;
    for (const reqItem of items) {
      const qty = Math.max(1, Math.min(20, Math.floor(Number(reqItem.quantity) || 1)));
      const invRow = db
        .prepare('SELECT * FROM inventory WHERE id = ? AND requires_prescription = 0')
        .get(reqItem.inventoryId) as Record<string, unknown> | undefined;
      if (!invRow) throw new Error('One or more items are unavailable.');
      if (Number(invRow.stock_quantity) < qty) {
        throw new Error(`Insufficient stock for ${String(invRow.name)}.`);
      }
      subtotalCents += Number(invRow.unit_price_cents) * qty;
    }
    const totalCents = subtotalCents + Math.round(subtotalCents * 0.15);
    const secret = process.env.PAYSTACK_SECRET_KEY?.trim();
    if (!secret) {
      res.status(503).json({ error: 'Online payment is not configured.' });
      return;
    }
    if (typeof callbackUrl !== 'string') {
      res.status(400).json({ error: 'A valid payment callback URL is required.' });
      return;
    }

    const callback = new URL(callbackUrl);
    const requestHost = req.headers.host;
    if (
      (callback.protocol !== 'http:' && callback.protocol !== 'https:') ||
      !requestHost ||
      callback.host !== requestHost
    ) {
      res.status(400).json({ error: 'A valid payment callback URL is required.' });
      return;
    }

    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        email: customerEmail.trim(),
        amount: totalCents,
        currency: 'GHS',
        callback_url: callback.toString(),
        metadata: { source: 'netanya-public-storefront', totalCents },
      }),
    });
    const payload = await response.json() as {
      status?: boolean;
      message?: string;
      data?: { authorization_url?: string; access_code?: string; reference?: string };
    };
    if (!response.ok || !payload.status || !payload.data?.authorization_url) {
      res.status(502).json({ error: payload.message || 'Unable to start payment.' });
      return;
    }
    res.json(payload.data);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to start payment.' });
  }
});

// Public / Patient OTC Retail Checkout
app.post('/api/public/orders', async (req: AuthedRequest, res) => {
  const { customerName, customerEmail, fulfillmentType, shippingAddress, items, paymentReference } = req.body as {
    customerName?: string;
    customerEmail?: string;
    fulfillmentType?: 'pickup' | 'delivery';
    shippingAddress?: string;
    items?: Array<{ inventoryId: string; quantity: number }>;
    paymentReference?: string;
  };

  if (!customerName || !customerEmail || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'Customer details and at least one retail item are required.' });
    return;
  }

  const header = req.headers.authorization || '';
  const session = header.startsWith('Bearer ') ? verifySessionToken(header.slice(7).trim()) : null;

  try {
    let preflightSubtotalCents = 0;
    for (const reqItem of items) {
      const qty = Math.max(1, Math.min(20, Math.floor(Number(reqItem.quantity) || 1)));
      const invRow = db
        .prepare('SELECT * FROM inventory WHERE id = ? AND requires_prescription = 0')
        .get(reqItem.inventoryId) as Record<string, unknown> | undefined;
      if (!invRow) throw new Error('One or more items are unavailable for checkout.');
      if (Number(invRow.stock_quantity) < qty) {
        throw new Error(`Insufficient stock for ${String(invRow.name)}.`);
      }
      preflightSubtotalCents += Number(invRow.unit_price_cents) * qty;
    }
    await verifyPaystackPayment(
      String(paymentReference || ''),
      preflightSubtotalCents + Math.round(preflightSubtotalCents * 0.15)
    );

    const result = runTx(() => {
      const resolvedItems: OtcOrderItem[] = [];
      let subtotalCents = 0;
      let poTriggered = false;

      for (const reqItem of items) {
        const qty = Math.max(1, Math.min(20, Math.floor(Number(reqItem.quantity) || 1)));
        const invRow = db
          .prepare('SELECT * FROM inventory WHERE id = ? AND requires_prescription = 0')
          .get(reqItem.inventoryId) as Record<string, unknown> | undefined;

        if (!invRow) {
          throw new Error('One or more items are unavailable for OTC retail checkout.');
        }
        const currentStock = Number(invRow.stock_quantity);
        if (currentStock < qty) {
          throw new Error(`Insufficient stock for ${String(invRow.name)} (${currentStock} left).`);
        }

        const newStock = currentStock - qty;
        db.prepare('UPDATE inventory SET stock_quantity = ? WHERE id = ?').run(
          newStock,
          String(invRow.id)
        );

        const unitPriceCents = Number(invRow.unit_price_cents);
        subtotalCents += unitPriceCents * qty;
        resolvedItems.push({
          inventoryId: String(invRow.id),
          name: String(invRow.name),
          quantity: qty,
          unitPriceCents,
        });

        if (
          checkAndTriggerAutoReplenishment(
            String(invRow.id),
            session?.uid || 'guest_checkout',
            session?.displayName || customerName,
            session?.role || 'public'
          )
        ) {
          poTriggered = true;
        }
      }

      const taxCents = Math.round(subtotalCents * 0.15);
      const totalCents = subtotalCents + taxCents;
      const orderId = `otc_${crypto.randomUUID().slice(0, 8)}`;
      const orderNumber = `ORD-${nextSequence('ord_seq', 77102)}`;
      const now = new Date().toISOString();
      const existingPayment = db
        .prepare('SELECT id FROM otc_orders WHERE payment_reference = ?')
        .get(String(paymentReference)) as { id: string } | undefined;
      if (existingPayment) {
        throw new Error('This payment has already been used for an order.');
      }
      const claimedPayment = db
        .prepare('SELECT reference FROM payment_references WHERE reference = ?')
        .get(String(paymentReference));
      if (claimedPayment) {
        throw new Error('This payment has already been used for an order.');
      }
      db.prepare(
        'INSERT INTO payment_references (reference, amount_cents, created_at) VALUES (?, ?, ?)'
      ).run(String(paymentReference), totalCents, now);

      db.prepare(
        `INSERT INTO otc_orders (
          id, order_number, customer_name, customer_email, fulfillment_type, shipping_address,
          items_json, subtotal_cents, tax_cents, total_cents, status, payment_reference,
          payment_method, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paystack', ?)`
      ).run(
        orderId,
        orderNumber,
        customerName.trim(),
        customerEmail.trim(),
        fulfillmentType === 'delivery' ? 'delivery' : 'pickup',
        fulfillmentType === 'delivery'
          ? (shippingAddress || 'Customer Address, Accra').trim()
          : 'In-Store Pickup · Netanya Pharmacy Desk, Accra',
        JSON.stringify(resolvedItems),
        subtotalCents,
        taxCents,
        totalCents,
        fulfillmentType === 'delivery' ? 'confirmed' : 'ready_for_pickup',
        String(paymentReference),
        now
      );

      writeAuditLog(
        session?.uid || 'guest_checkout',
        session?.displayName || customerName.trim(),
        session?.role || 'public',
        'OTC_ORDER_PLACED',
        'otc_orders',
        orderId,
        `Retail order ${orderNumber} placed for GH₵${(totalCents / 100).toFixed(2)}.`
      );

      return {
        order: {
          id: orderId,
          orderNumber,
          customerName: customerName.trim(),
          customerEmail: customerEmail.trim(),
          fulfillmentType: fulfillmentType === 'delivery' ? 'delivery' : 'pickup',
          shippingAddress:
            fulfillmentType === 'delivery'
              ? (shippingAddress || '').trim()
              : 'In-Store Pickup · Netanya Pharmacy Desk, Accra',
          items: resolvedItems,
          subtotalCents,
          taxCents,
          totalCents,
          status: fulfillmentType === 'delivery' ? 'confirmed' : 'ready_for_pickup',
          createdAt: now,
        },
        poTriggered,
      };
    });

    broadcastTopics(
      result.poTriggered
        ? ['inventory', 'replenishments', 'analytics', 'audit']
        : ['inventory', 'analytics', 'audit']
    );
    res.status(201).json({ order: result.order });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Checkout failed.' });
  }
});

// Authentication
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required.' });
    return;
  }

  const row = db
    .prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)')
    .get(email.trim()) as Record<string, unknown> | undefined;

  if (!row || !verifyPassword(password, String(row.password_hash))) {
    res.status(401).json({ error: 'Invalid email or password.' });
    return;
  }

  const user = {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    role: row.role as UserRole,
    consentAcceptedAt: row.consent_accepted_at ? String(row.consent_accepted_at) : null,
    marketingOptIn: Number(row.marketing_opt_in) === 1,
  };

  const token = signSessionToken({
    uid: user.id,
    role: user.role,
    email: user.email,
    displayName: user.displayName,
  });

  writeAuditLog(
    user.id,
    user.displayName,
    user.role,
    'PORTAL_LOGIN',
    'users',
    user.id,
    `Authenticated into ${user.role} portal.`
  );
  broadcastTopics(['audit']);

  res.json({ token, user });
});

app.post('/api/auth/register', (req, res) => {
  const {
    email,
    password,
    displayName,
    dob,
    phone,
    address,
    allergies,
    insuranceProvider,
    memberId,
    consentAccepted,
  } = req.body as {
    email?: string;
    password?: string;
    displayName?: string;
    dob?: string;
    phone?: string;
    address?: string;
    allergies?: string;
    insuranceProvider?: string;
    memberId?: string;
    consentAccepted?: boolean;
  };

  if (!email || !password || password.length < 8 || !displayName || !consentAccepted) {
    res.status(400).json({
      error: 'Valid email, name, password (8+ chars), and HIPAA/GDPR privacy consent are required.',
    });
    return;
  }

  const existing = db
    .prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)')
    .get(email.trim());
  if (existing) {
    res.status(409).json({ error: 'An account with this email already exists.' });
    return;
  }

  const uid = `usr_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = displayName.trim();

  runTx(() => {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, role, consent_accepted_at, marketing_opt_in, created_at)
       VALUES (?, ?, ?, ?, 'patient', ?, 0, ?)`
    ).run(uid, cleanEmail, hashPassword(password), cleanName, now, now);

    const phiPayload: PatientPHI = {
      dob: dob || '1990-01-01',
      phone: phone || 'Not provided',
      address: address || 'Not provided',
      allergies: allergies
        ? allergies
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean)
        : ['No Known Drug Allergies'],
      insuranceProvider: insuranceProvider || 'NHIS (National Health Insurance)',
      bin: '233001',
      pcn: 'NHISGH',
      groupNumber: 'NHIS-10020',
      memberId: memberId || `GHA-NHIS-${nextSequence('nrx_seq', 99412055)}`,
    };

    db.prepare(
      `INSERT INTO patients_phi (user_id, encrypted_payload, updated_at) VALUES (?, ?, ?)`
    ).run(uid, encryptPHI(phiPayload), now);

    const threadId = `con_${crypto.randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO consultations (id, patient_id, patient_name, subject, status, last_message_at, unread_count)
       VALUES (?, ?, ?, 'New Patient Clinical Onboarding', 'open', ?, 0)`
    ).run(threadId, uid, cleanName, now);

    writeAuditLog(
      uid,
      cleanName,
      'patient',
      'PATIENT_REGISTERED',
      'patients_phi',
      uid,
      'Registered patient account with AES-256-GCM encrypted PHI vault.'
    );
  });

  const token = signSessionToken({
    uid,
    role: 'patient',
    email: cleanEmail,
    displayName: cleanName,
  });

  res.status(201).json({
    token,
    user: {
      id: uid,
      email: cleanEmail,
      displayName: cleanName,
      role: 'patient' as UserRole,
      consentAcceptedAt: now,
      marketingOptIn: false,
    },
  });
});

app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
  const row = db
    .prepare('SELECT id, email, display_name, role, consent_accepted_at, marketing_opt_in FROM users WHERE id = ?')
    .get(req.user!.uid) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: 'User profile not found.' });
    return;
  }
  res.json({
    user: {
      id: String(row.id),
      email: String(row.email),
      displayName: String(row.display_name),
      role: row.role as UserRole,
      consentAcceptedAt: row.consent_accepted_at ? String(row.consent_accepted_at) : null,
      marketingOptIn: Number(row.marketing_opt_in) === 1,
    },
  });
});

// ================= PATIENT PORTAL =================

function safeDecryptPHI(payload: string | null | undefined): PatientPHI | null {
  if (!payload) return null;
  try {
    return decryptPHI<PatientPHI>(payload);
  } catch {
    return null;
  }
}

app.get('/api/patient/dashboard', requireAuth, requireRole('patient'), (req: AuthedRequest, res) => {
  const uid = req.user!.uid;
  const phiRow = db
    .prepare('SELECT encrypted_payload FROM patients_phi WHERE user_id = ?')
    .get(uid) as { encrypted_payload: string } | undefined;

  const phi: PatientPHI | null = safeDecryptPHI(phiRow?.encrypted_payload);

  const rxRows = db
    .prepare('SELECT * FROM prescriptions WHERE patient_id = ? ORDER BY updated_at DESC')
    .all(uid) as Record<string, unknown>[];

  const careRows = db
    .prepare('SELECT * FROM care_plans WHERE patient_id = ? ORDER BY updated_at DESC')
    .all(uid) as Record<string, unknown>[];

  const remRows = db
    .prepare('SELECT * FROM medication_reminders WHERE patient_id = ? ORDER BY time_of_day ASC')
    .all(uid) as Record<string, unknown>[];

  const claimRows = db
    .prepare('SELECT * FROM insurance_claims WHERE patient_id = ? ORDER BY updated_at DESC')
    .all(uid) as Record<string, unknown>[];

  const orderRows = db
    .prepare('SELECT * FROM otc_orders WHERE LOWER(customer_email) = LOWER(?) ORDER BY created_at DESC')
    .all(req.user!.email) as Record<string, unknown>[];

  res.json({
    phi,
    prescriptions: rxRows.map((r) => ({
      id: String(r.id),
      rxNumber: String(r.rx_number),
      patientId: String(r.patient_id),
      patientName: String(r.patient_name),
      inventoryId: String(r.inventory_id),
      medicationName: String(r.medication_name),
      ndcCode: String(r.ndc_code),
      prescriberName: String(r.prescriber_name),
      dosageInstructions: String(r.dosage_instructions),
      quantity: Number(r.quantity),
      daysSupply: Number(r.days_supply),
      refillsRemaining: Number(r.refills_remaining),
      nextRefillEligibleAt: String(r.next_refill_eligible_at),
      status: r.status as PrescriptionStatus,
      unitPriceCents: Number(r.unit_price_cents),
      updatedAt: String(r.updated_at),
    })),
    carePlans: careRows.map((c) => ({
      id: String(c.id),
      patientId: String(c.patient_id),
      patientName: String(c.patient_name),
      pharmacistName: String(c.pharmacist_name),
      conditionFocus: String(c.condition_focus),
      clinicalGoals: String(c.clinical_goals),
      interactionWarnings: String(c.interaction_warnings),
      adherenceNotes: String(c.adherence_notes),
      followUpDate: String(c.follow_up_date),
      updatedAt: String(c.updated_at),
    })),
    reminders: remRows.map((m) => ({
      id: String(m.id),
      patientId: String(m.patient_id),
      medicationName: String(m.medication_name),
      dosageLabel: String(m.dosage_label),
      timeOfDay: String(m.time_of_day),
      frequency: String(m.frequency),
      pushEnabled: Number(m.push_enabled) === 1,
      lastTakenDate: m.last_taken_date ? String(m.last_taken_date) : null,
      adherenceStreak: Number(m.adherence_streak),
    })),
    claims: claimRows.map((c) => ({
      id: String(c.id),
      claimNumber: String(c.claim_number),
      prescriptionId: String(c.prescription_id),
      rxNumber: String(c.rx_number),
      patientId: String(c.patient_id),
      patientName: String(c.patient_name),
      medicationName: String(c.medication_name),
      payerName: String(c.payer_name),
      bin: String(c.bin),
      pcn: String(c.pcn),
      groupId: String(c.group_id),
      formularyTier: Number(c.formulary_tier) as 1 | 2 | 3,
      dawCode: String(c.daw_code) as '0' | '1' | '2',
      daysSupply: Number(c.days_supply),
      ucPriceCents: Number(c.uc_price_cents),
      allowedAmountCents: Number(c.allowed_amount_cents),
      insurerPaidCents: Number(c.insurer_paid_cents),
      deductibleAppliedCents: Number(c.deductible_applied_cents),
      patientCopayCents: Number(c.patient_copay_cents),
      rejectionCode: String(c.rejection_code) as NcpdpRejectionCode,
      rejectionMessage: String(c.rejection_message),
      overrideCode: String(c.override_code),
      overrideNotes: String(c.override_notes),
      claimStatus: String(c.claim_status),
      updatedAt: String(c.updated_at),
    })),
    orders: orderRows.map((o) => ({
      id: String(o.id),
      orderNumber: String(o.order_number),
      customerName: String(o.customer_name),
      customerEmail: String(o.customer_email),
      fulfillmentType: o.fulfillment_type as 'pickup' | 'delivery',
      shippingAddress: String(o.shipping_address),
      items: JSON.parse(String(o.items_json)),
      subtotalCents: Number(o.subtotal_cents),
      taxCents: Number(o.tax_cents),
      totalCents: Number(o.total_cents),
      status: String(o.status),
      createdAt: String(o.created_at),
    })),
  });
});

app.post('/api/patient/prescriptions/refill', requireAuth, requireRole('patient'), (req: AuthedRequest, res) => {
  const { prescriptionId } = req.body as { prescriptionId?: string };
  if (!prescriptionId) {
    res.status(400).json({ error: 'prescriptionId is required.' });
    return;
  }

  const rx = db
    .prepare('SELECT * FROM prescriptions WHERE id = ? AND patient_id = ?')
    .get(prescriptionId, req.user!.uid) as Record<string, unknown> | undefined;

  if (!rx) {
    res.status(404).json({ error: 'Prescription not found.' });
    return;
  }
  if (Number(rx.refills_remaining) <= 0) {
    res.status(400).json({ error: 'Zero refills remaining. Please contact your prescriber.' });
    return;
  }

  const now = new Date().toISOString();
  runTx(() => {
    db.prepare(
      `UPDATE prescriptions SET status = 'submitted', refills_remaining = refills_remaining - 1, updated_at = ? WHERE id = ?`
    ).run(now, prescriptionId);

    writeAuditLog(
      req.user!.uid,
      req.user!.displayName,
      'patient',
      'REFILL_REQUESTED',
      'prescriptions',
      prescriptionId,
      `Patient requested automated refill for ${String(rx.rx_number)} (${String(rx.medication_name)}).`
    );
  });

  broadcastTopics(['prescriptions', 'analytics', 'audit']);
  res.json({ ok: true, status: 'submitted' });
});

app.post('/api/patient/reminders', requireAuth, requireRole('patient'), (req: AuthedRequest, res) => {
  const { medicationName, dosageLabel, timeOfDay, frequency, pushEnabled } = req.body as {
    medicationName?: string;
    dosageLabel?: string;
    timeOfDay?: string;
    frequency?: string;
    pushEnabled?: boolean;
  };
  if (!medicationName || !timeOfDay) {
    res.status(400).json({ error: 'Medication name and dose time are required.' });
    return;
  }

  const id = `rem_${crypto.randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO medication_reminders (id, patient_id, medication_name, dosage_label, time_of_day, frequency, push_enabled, last_taken_date, adherence_streak)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)`
  ).run(
    id,
    req.user!.uid,
    medicationName.trim(),
    (dosageLabel || '1 dose').trim(),
    timeOfDay.trim(),
    (frequency || 'Daily').trim(),
    pushEnabled !== false ? 1 : 0
  );

  res.status(201).json({ ok: true, id });
});

app.patch('/api/patient/reminders/:id/take', requireAuth, requireRole('patient'), (req: AuthedRequest, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const rem = db
    .prepare('SELECT * FROM medication_reminders WHERE id = ? AND patient_id = ?')
    .get(req.params.id, req.user!.uid) as Record<string, unknown> | undefined;
  if (!rem) {
    res.status(404).json({ error: 'Reminder not found.' });
    return;
  }

  const alreadyTaken = rem.last_taken_date === today;
  const newStreak = alreadyTaken ? Number(rem.adherence_streak) : Number(rem.adherence_streak) + 1;
  db.prepare(
    'UPDATE medication_reminders SET last_taken_date = ?, adherence_streak = ? WHERE id = ?'
  ).run(today, newStreak, req.params.id);

  res.json({ ok: true, lastTakenDate: today, adherenceStreak: newStreak });
});

app.patch('/api/patient/reminders/:id', requireAuth, requireRole('patient'), (req: AuthedRequest, res) => {
  const { pushEnabled, timeOfDay, dosageLabel } = req.body as {
    pushEnabled?: boolean;
    timeOfDay?: string;
    dosageLabel?: string;
  };
  const rem = db
    .prepare('SELECT * FROM medication_reminders WHERE id = ? AND patient_id = ?')
    .get(req.params.id, req.user!.uid) as Record<string, unknown> | undefined;
  if (!rem) {
    res.status(404).json({ error: 'Reminder not found.' });
    return;
  }
  db.prepare(
    'UPDATE medication_reminders SET push_enabled = ?, time_of_day = ?, dosage_label = ? WHERE id = ?'
  ).run(
    typeof pushEnabled === 'boolean' ? (pushEnabled ? 1 : 0) : Number(rem.push_enabled),
    timeOfDay ? timeOfDay.trim() : String(rem.time_of_day),
    dosageLabel ? dosageLabel.trim() : String(rem.dosage_label),
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/patient/reminders/:id', requireAuth, requireRole('patient'), (req: AuthedRequest, res) => {
  db.prepare('DELETE FROM medication_reminders WHERE id = ? AND patient_id = ?').run(
    req.params.id,
    req.user!.uid
  );
  res.json({ ok: true });
});

app.patch('/api/patient/profile', requireAuth, requireRole('patient'), (req: AuthedRequest, res) => {
  const uid = req.user!.uid;
  const phiRow = db
    .prepare('SELECT encrypted_payload FROM patients_phi WHERE user_id = ?')
    .get(uid) as { encrypted_payload: string } | undefined;
  if (!phiRow) {
    res.status(404).json({ error: 'Patient PHI record not found.' });
    return;
  }
  const current = safeDecryptPHI(phiRow.encrypted_payload) || {
    dob: '1990-01-01',
    phone: '',
    address: '',
    allergies: ['No Known Drug Allergies'],
    insuranceProvider: 'NHIS (National Health Insurance)',
    bin: '233001',
    pcn: 'NHISGH',
    groupNumber: 'NHIS-100',
    memberId: '',
  };
  const { phone, address, allergies, insuranceProvider, bin, pcn, groupNumber, memberId } =
    req.body as Partial<PatientPHI>;

  const updated: PatientPHI = {
    ...current,
    phone: phone !== undefined ? String(phone).trim() : current.phone,
    address: address !== undefined ? String(address).trim() : current.address,
    allergies: Array.isArray(allergies)
      ? allergies.map((a) => String(a).trim()).filter(Boolean)
      : current.allergies,
    insuranceProvider:
      insuranceProvider !== undefined ? String(insuranceProvider).trim() : current.insuranceProvider,
    bin: bin !== undefined ? String(bin).trim() : current.bin,
    pcn: pcn !== undefined ? String(pcn).trim() : current.pcn,
    groupNumber: groupNumber !== undefined ? String(groupNumber).trim() : current.groupNumber,
    memberId: memberId !== undefined ? String(memberId).trim() : current.memberId,
  };

  const now = new Date().toISOString();
  db.prepare('UPDATE patients_phi SET encrypted_payload = ?, updated_at = ? WHERE user_id = ?').run(
    encryptPHI(updated),
    now,
    uid
  );
  writeAuditLog(
    uid,
    req.user!.displayName,
    'patient',
    'PATIENT_PHI_UPDATED',
    'patients_phi',
    uid,
    'Patient updated contact, delivery address, or insurance card details.'
  );
  broadcastTopics(['prescriptions', 'audit']);
  res.json({ ok: true, phi: updated });
});

app.patch('/api/patient/privacy/consent', requireAuth, requireRole('patient'), (req: AuthedRequest, res) => {
  const { marketingOptIn } = req.body as { marketingOptIn?: boolean };
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET marketing_opt_in = ?, consent_accepted_at = ? WHERE id = ?').run(
    marketingOptIn ? 1 : 0,
    now,
    req.user!.uid
  );
  writeAuditLog(
    req.user!.uid,
    req.user!.displayName,
    'patient',
    'GDPR_CONSENT_UPDATED',
    'users',
    req.user!.uid,
    `Updated GDPR communication preferences (opt-in=${Boolean(marketingOptIn)}).`
  );
  broadcastTopics(['audit']);
  res.json({ ok: true, marketingOptIn: Boolean(marketingOptIn), consentAcceptedAt: now });
});

app.get('/api/patient/privacy/export', requireAuth, requireRole('patient'), (req: AuthedRequest, res) => {
  const uid = req.user!.uid;
  const userRow = db
    .prepare('SELECT id, email, display_name, role, consent_accepted_at, marketing_opt_in, created_at FROM users WHERE id = ?')
    .get(uid);
  const phiRow = db
    .prepare('SELECT encrypted_payload FROM patients_phi WHERE user_id = ?')
    .get(uid) as { encrypted_payload: string } | undefined;
  const prescriptions = db.prepare('SELECT * FROM prescriptions WHERE patient_id = ?').all(uid);
  const carePlans = db.prepare('SELECT * FROM care_plans WHERE patient_id = ?').all(uid);
  const reminders = db.prepare('SELECT * FROM medication_reminders WHERE patient_id = ?').all(uid);

  writeAuditLog(
    uid,
    req.user!.displayName,
    'patient',
    'GDPR_DATA_EXPORTED',
    'patients_phi',
    uid,
    'Patient exported portable GDPR Article 20 clinical & personal archive.'
  );
  broadcastTopics(['audit']);

  res.json({
    exportedAt: new Date().toISOString(),
    standard: 'GDPR Article 20 Portable Archive / HIPAA Designated Record Set',
    account: userRow,
    protectedHealthInfo: safeDecryptPHI(phiRow?.encrypted_payload),
    prescriptions,
    carePlans,
    medicationReminders: reminders,
  });
});

app.post('/api/patient/privacy/erasure', requireAuth, requireRole('patient'), (req: AuthedRequest, res) => {
  const uid = req.user!.uid;
  const now = new Date().toISOString();

  runTx(() => {
    db.prepare('DELETE FROM medication_reminders WHERE patient_id = ?').run(uid);
    db.prepare(
      `DELETE FROM consultation_messages WHERE thread_id IN (SELECT id FROM consultations WHERE patient_id = ?)`
    ).run(uid);
    db.prepare('DELETE FROM consultations WHERE patient_id = ?').run(uid);

    const phiRow = db
      .prepare('SELECT encrypted_payload FROM patients_phi WHERE user_id = ?')
      .get(uid) as { encrypted_payload: string } | undefined;

    if (phiRow) {
      try {
        const existing = decryptPHI<PatientPHI>(phiRow.encrypted_payload);
        const redacted: PatientPHI = {
          ...existing,
          phone: '[ERASED]',
          address: '[ERASED]',
        };
        db.prepare('UPDATE patients_phi SET encrypted_payload = ?, updated_at = ? WHERE user_id = ?').run(
          encryptPHI(redacted),
          now,
          uid
        );
      } catch {
        // Ignore if PHI row cannot be parsed
      }
    }

    const anonLabel = `Erased Patient #${uid.slice(-4).toUpperCase()}`;
    db.prepare(
      `UPDATE users SET display_name = ?, marketing_opt_in = 0, consent_accepted_at = NULL WHERE id = ?`
    ).run(anonLabel, uid);

    writeAuditLog(
      uid,
      anonLabel,
      'patient',
      'ACT843_GDPR_ERASURE_EXECUTED',
      'users',
      uid,
      'Executed non-statutory personal data purge (reminders, consult chats, contact PHI redacted); statutory Rx dispensing & claim logs retained under Pharmacy Council law.'
    );
  });

  broadcastTopics(['consultations', 'analytics', 'audit']);
  res.json({
    ok: true,
    erased: true,
    message:
      'Non-statutory personal data (reminders, pharmacist chat history, contact phone/address, and marketing consent) has been permanently erased. Statutory pharmacy dispensing records remain sealed under retention law.',
  });
});

// ================= PHARMACIST / STAFF PORTAL =================

app.get('/api/staff/workspace', requireAuth, requireRole('pharmacist', 'owner'), (req: AuthedRequest, res) => {
  const invRows = db.prepare('SELECT * FROM inventory ORDER BY category, name').all() as Record<string, unknown>[];
  const rxRows = db.prepare('SELECT * FROM prescriptions ORDER BY updated_at DESC').all() as Record<string, unknown>[];
  const careRows = db.prepare('SELECT * FROM care_plans ORDER BY updated_at DESC').all() as Record<string, unknown>[];
  const claimRows = db.prepare('SELECT * FROM insurance_claims ORDER BY updated_at DESC').all() as Record<string, unknown>[];
  const planRows = db.prepare('SELECT * FROM insurance_plans ORDER BY payer_name').all() as Record<string, unknown>[];
  const poRows = db.prepare('SELECT * FROM replenishment_orders ORDER BY created_at DESC').all() as Record<string, unknown>[];

  const patientRows = db
    .prepare(
      `SELECT u.id, u.display_name, u.email, p.encrypted_payload
       FROM users u LEFT JOIN patients_phi p ON p.user_id = u.id
       WHERE u.role = 'patient' ORDER BY u.display_name`
    )
    .all() as Record<string, unknown>[];

  const patients = patientRows.map((p) => {
    const phi = p.encrypted_payload ? safeDecryptPHI(String(p.encrypted_payload)) : null;
    return {
      id: String(p.id),
      displayName: String(p.display_name),
      email: String(p.email),
      phi,
    };
  });

  res.json({
    inventory: invRows.map(mapInventoryRow),
    prescriptions: rxRows.map((r) => ({
      id: String(r.id),
      rxNumber: String(r.rx_number),
      patientId: String(r.patient_id),
      patientName: String(r.patient_name),
      inventoryId: String(r.inventory_id),
      medicationName: String(r.medication_name),
      ndcCode: String(r.ndc_code),
      prescriberName: String(r.prescriber_name),
      dosageInstructions: String(r.dosage_instructions),
      quantity: Number(r.quantity),
      daysSupply: Number(r.days_supply),
      refillsRemaining: Number(r.refills_remaining),
      nextRefillEligibleAt: String(r.next_refill_eligible_at),
      status: r.status as PrescriptionStatus,
      unitPriceCents: Number(r.unit_price_cents),
      updatedAt: String(r.updated_at),
    })),
    carePlans: careRows.map((c) => ({
      id: String(c.id),
      patientId: String(c.patient_id),
      patientName: String(c.patient_name),
      pharmacistName: String(c.pharmacist_name),
      conditionFocus: String(c.condition_focus),
      clinicalGoals: String(c.clinical_goals),
      interactionWarnings: String(c.interaction_warnings),
      adherenceNotes: String(c.adherence_notes),
      followUpDate: String(c.follow_up_date),
      updatedAt: String(c.updated_at),
    })),
    claims: claimRows.map((c) => ({
      id: String(c.id),
      claimNumber: String(c.claim_number),
      prescriptionId: String(c.prescription_id),
      rxNumber: String(c.rx_number),
      patientId: String(c.patient_id),
      patientName: String(c.patient_name),
      medicationName: String(c.medication_name),
      payerName: String(c.payer_name),
      bin: String(c.bin),
      pcn: String(c.pcn),
      groupId: String(c.group_id),
      formularyTier: Number(c.formulary_tier) as 1 | 2 | 3,
      dawCode: String(c.daw_code) as '0' | '1' | '2',
      daysSupply: Number(c.days_supply),
      ucPriceCents: Number(c.uc_price_cents),
      allowedAmountCents: Number(c.allowed_amount_cents),
      insurerPaidCents: Number(c.insurer_paid_cents),
      deductibleAppliedCents: Number(c.deductible_applied_cents),
      patientCopayCents: Number(c.patient_copay_cents),
      rejectionCode: String(c.rejection_code) as NcpdpRejectionCode,
      rejectionMessage: String(c.rejection_message),
      overrideCode: String(c.override_code),
      overrideNotes: String(c.override_notes),
      claimStatus: String(c.claim_status),
      updatedAt: String(c.updated_at),
    })),
    insurancePlans: planRows.map((p) => ({
      id: String(p.id),
      payerName: String(p.payer_name),
      bin: String(p.bin),
      pcn: String(p.pcn),
      groupPrefix: String(p.group_prefix),
      tier1CopayCents: Number(p.tier1_copay_cents),
      tier2CopayCents: Number(p.tier2_copay_cents),
      tier3CopayCents: Number(p.tier3_copay_cents),
      reimbursementRate: Number(p.reimbursement_rate),
    })),
    replenishments: poRows.map((po) => ({
      id: String(po.id),
      poNumber: String(po.po_number),
      inventoryId: String(po.inventory_id),
      medicationName: String(po.medication_name),
      ndcCode: String(po.ndc_code),
      supplierId: String(po.supplier_id),
      supplierName: String(po.supplier_name),
      requestedQty: Number(po.requested_qty),
      confirmedQty: po.confirmed_qty !== null ? Number(po.confirmed_qty) : null,
      batchNumber: po.batch_number ? String(po.batch_number) : null,
      batchExpiry: po.batch_expiry ? String(po.batch_expiry) : null,
      scheduledDeliveryDate: po.scheduled_delivery_date ? String(po.scheduled_delivery_date) : null,
      deliveryWindow: po.delivery_window ? String(po.delivery_window) : null,
      status: po.status as ReplenishmentStatus,
      autoTriggered: Number(po.auto_triggered) === 1,
      createdAt: String(po.created_at),
      updatedAt: String(po.updated_at),
    })),
    otcOrders: (
      db.prepare('SELECT * FROM otc_orders ORDER BY created_at DESC LIMIT 30').all() as Record<
        string,
        unknown
      >[]
    ).map((o) => ({
      id: String(o.id),
      orderNumber: String(o.order_number),
      customerName: String(o.customer_name),
      customerEmail: String(o.customer_email),
      fulfillmentType: o.fulfillment_type as 'pickup' | 'delivery',
      shippingAddress: String(o.shipping_address),
      items: JSON.parse(String(o.items_json)),
      subtotalCents: Number(o.subtotal_cents),
      taxCents: Number(o.tax_cents),
      totalCents: Number(o.total_cents),
      status: String(o.status),
      createdAt: String(o.created_at),
    })),
    posReceipts: (
      db.prepare('SELECT * FROM pos_transactions ORDER BY created_at DESC LIMIT 30').all() as Record<
        string,
        unknown
      >[]
    ).map((r) => ({
      id: String(r.id),
      receiptNumber: String(r.receipt_number),
      customerName: String(r.customer_name),
      cashierName: String(r.cashier_name),
      paymentMethod: r.payment_method as 'cash' | 'card' | 'mobile_pay',
      discountPercent: Number(r.discount_percent),
      otcLines: JSON.parse(String(r.otc_lines_json)),
      rxLines: JSON.parse(String(r.rx_lines_json)),
      serviceLines: r.service_lines_json ? JSON.parse(String(r.service_lines_json)) : [],
      subtotalCents: Number(r.subtotal_cents),
      discountCents: Number(r.discount_cents),
      taxCents: Number(r.tax_cents),
      rxCopayTotalCents: Number(r.rx_copay_total_cents),
      serviceTotalCents: Number(r.service_total_cents || 0),
      grandTotalCents: Number(r.grand_total_cents),
      tenderedCents: Number(r.tendered_cents),
      changeDueCents: Number(r.change_due_cents),
      poTriggered: false,
      createdAt: String(r.created_at),
    })),
    services: (
      db.prepare('SELECT * FROM pharmacy_services ORDER BY category, name').all() as Record<
        string,
        unknown
      >[]
    ).map(mapServiceRow),
    serviceLogs: (
      db.prepare('SELECT * FROM service_logs ORDER BY created_at DESC LIMIT 30').all() as Record<
        string,
        unknown
      >[]
    ).map(mapServiceLogRow),
    drawerEvents: (
      db
        .prepare('SELECT * FROM cash_drawer_events ORDER BY authorized_at DESC LIMIT 30')
        .all() as Record<string, unknown>[]
    ).map(mapDrawerEventRow),
    patients,
  });
});

app.post('/api/staff/prescriptions', requireAuth, requireRole('pharmacist', 'owner'), (req: AuthedRequest, res) => {
  const { patientId, inventoryId, prescriberName, dosageInstructions, quantity, daysSupply, refillsRemaining } =
    req.body as {
      patientId?: string;
      inventoryId?: string;
      prescriberName?: string;
      dosageInstructions?: string;
      quantity?: number;
      daysSupply?: number;
      refillsRemaining?: number;
    };

  if (!patientId || !inventoryId || !prescriberName || !dosageInstructions) {
    res.status(400).json({ error: 'Patient, medication, prescriber, and dosage instructions are required.' });
    return;
  }

  const patient = db
    .prepare('SELECT id, display_name FROM users WHERE id = ? AND role = ?')
    .get(patientId, 'patient') as { id: string; display_name: string } | undefined;
  const inv = db
    .prepare('SELECT * FROM inventory WHERE id = ?')
    .get(inventoryId) as Record<string, unknown> | undefined;

  if (!patient || !inv) {
    res.status(404).json({ error: 'Patient or inventory medication not found.' });
    return;
  }

  const id = `rx_${crypto.randomUUID().slice(0, 8)}`;
  const rxNumber = `RX-2026-${nextSequence('rx_seq', 8854)}`;
  const now = new Date().toISOString();
  const supply = Math.max(1, Math.min(180, Number(daysSupply) || 30));
  const nextRefill = new Date(Date.now() + Math.floor(supply * 0.75) * 86400000).toISOString();

  runTx(() => {
    db.prepare(
      `INSERT INTO prescriptions (
        id, rx_number, patient_id, patient_name, inventory_id, medication_name, ndc_code,
        prescriber_name, dosage_instructions, quantity, days_supply, refills_remaining,
        next_refill_eligible_at, status, unit_price_cents, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verifying', ?, ?)`
    ).run(
      id,
      rxNumber,
      patient.id,
      patient.display_name,
      String(inv.id),
      String(inv.name),
      String(inv.ndc_code),
      prescriberName.trim(),
      dosageInstructions.trim(),
      Math.max(1, Number(quantity) || 30),
      supply,
      Math.max(0, Number(refillsRemaining) || 2),
      nextRefill,
      Number(inv.unit_price_cents),
      now
    );

    writeAuditLog(
      req.user!.uid,
      req.user!.displayName,
      req.user!.role,
      'RX_CREATED',
      'prescriptions',
      id,
      `Entered e-Rx ${rxNumber} (${String(inv.name)}) for ${patient.display_name}.`
    );
  });

  broadcastTopics(['prescriptions', 'analytics', 'audit']);
  res.status(201).json({ ok: true, id, rxNumber });
});

app.patch('/api/staff/patients/:id/phi', requireAuth, requireRole('pharmacist', 'owner'), (req: AuthedRequest, res) => {
  const phiRow = db
    .prepare('SELECT encrypted_payload FROM patients_phi WHERE user_id = ?')
    .get(req.params.id) as { encrypted_payload: string } | undefined;
  if (!phiRow) {
    res.status(404).json({ error: 'Patient PHI record not found.' });
    return;
  }
  const current = safeDecryptPHI(phiRow.encrypted_payload) || {
    dob: '1990-01-01',
    phone: '',
    address: '',
    allergies: ['No Known Drug Allergies'],
    insuranceProvider: 'NHIS (National Health Insurance)',
    bin: '233001',
    pcn: 'NHISGH',
    groupNumber: 'NHIS-100',
    memberId: '',
  };
  const { allergies, insuranceProvider, bin, pcn, groupNumber, memberId } =
    req.body as Partial<PatientPHI>;
  const updated: PatientPHI = {
    ...current,
    allergies: Array.isArray(allergies)
      ? allergies.map((a) => String(a).trim()).filter(Boolean)
      : current.allergies,
    insuranceProvider: insuranceProvider ?? current.insuranceProvider,
    bin: bin ?? current.bin,
    pcn: pcn ?? current.pcn,
    groupNumber: groupNumber ?? current.groupNumber,
    memberId: memberId ?? current.memberId,
  };
  db.prepare('UPDATE patients_phi SET encrypted_payload = ?, updated_at = ? WHERE user_id = ?').run(
    encryptPHI(updated),
    new Date().toISOString(),
    req.params.id
  );
  writeAuditLog(
    req.user!.uid,
    req.user!.displayName,
    req.user!.role,
    'STAFF_PHI_UPDATED',
    'patients_phi',
    req.params.id,
    'Pharmacist updated patient allergy or insurance coverage metadata.'
  );
  broadcastTopics(['prescriptions', 'audit']);
  res.json({ ok: true, phi: updated });
});

app.get(
  '/api/staff/drug-lookup',
  requireAuth,
  requireRole('pharmacist', 'owner'),
  async (req: AuthedRequest, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      res.status(400).json({ error: 'Enter at least 2 characters to search official drug records.' });
      return;
    }

    try {
      const splRes = await fetch(
        `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?drug_name=${encodeURIComponent(q)}&pagesize=8`
      );
      if (!splRes.ok) {
        res.status(502).json({ error: 'Official DailyMed lookup is temporarily unavailable.' });
        return;
      }
      const splJson = (await splRes.json()) as {
        data?: Array<{ setid: string; title: string }>;
      };
      const candidates = (splJson.data || []).filter(
        (s) => !/veterinary|vet\b/i.test(s.title || '')
      );

      const results: OfficialDrugLookupResult[] = [];
      const drugImgDir = path.resolve(process.cwd(), 'public', 'drug-images');
      fs.mkdirSync(drugImgDir, { recursive: true });

      const cleanClip = (arr?: string[], max = 420): string => {
        if (!arr || arr.length === 0) return '';
        return arr[0].replace(/\s+/g, ' ').trim().slice(0, max);
      };

      for (const spl of candidates.slice(0, 4)) {
        try {
          const [fdaRes, mediaRes, xmlRes] = await Promise.all([
            fetch(
              `https://api.fda.gov/drug/label.json?search=openfda.spl_set_id:"${encodeURIComponent(spl.setid)}"&limit=1`
            ).catch(() => null),
            fetch(
              `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/${encodeURIComponent(spl.setid)}/media.json`
            ).catch(() => null),
            fetch(
              `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/${encodeURIComponent(spl.setid)}.xml`
            ).catch(() => null),
          ]);

          let fdaDoc: Record<string, unknown> | undefined;
          if (fdaRes && fdaRes.ok) {
            const fdaJson = (await fdaRes.json()) as { results?: Array<Record<string, unknown>> };
            fdaDoc = fdaJson.results?.[0];
          }

          let preferredImgName: string | null = null;
          if (xmlRes && xmlRes.ok) {
            const xmlText = await xmlRes.text();
            const pdpMatch = xmlText.match(/code="51945-4"[\s\S]*?<\/section>/i);
            const pdpImg = pdpMatch?.[0].match(/<reference\s+value="([^"]+\.(?:jpg|jpeg|png))"/i);
            if (pdpImg?.[1]) {
              preferredImgName = pdpImg[1];
            }
          }

          let imageUrl: string | null = null;
          if (mediaRes && mediaRes.ok) {
            const mj = (await mediaRes.json()) as {
              data?: { media?: Array<{ name: string; mime_type?: string; url: string }> };
            };
            const mediaList = (mj.data?.media || []).filter(
              (m) =>
                m.mime_type?.startsWith('image/') &&
                !/struct|chem|fig|graph|eq|cup|syring|qr/i.test(m.name)
            );
            const chosen =
              (preferredImgName && mediaList.find((m) => m.name === preferredImgName)) ||
              mediaList[mediaList.length - 1] ||
              mediaList[0];

            if (chosen?.url) {
              const safeSet = spl.setid.replace(/[^a-zA-Z0-9-]/g, '');
              const ext = chosen.mime_type?.includes('png') ? 'png' : 'jpg';
              const localFile = `dm_${safeSet}.${ext}`;
              const localPath = path.join(drugImgDir, localFile);
              if (!fs.existsSync(localPath)) {
                const imgResp = await fetch(chosen.url).catch(() => null);
                if (imgResp && imgResp.ok) {
                  const buf = Buffer.from(await imgResp.arrayBuffer());
                  if (buf.length > 500) {
                    fs.writeFileSync(localPath, buf);
                  }
                }
              }
              if (fs.existsSync(localPath)) {
                imageUrl = `/drug-images/${localFile}`;
              }
            }
          }

          const openfda = (fdaDoc?.openfda || {}) as Record<string, string[] | undefined>;
          const brandName = openfda.brand_name?.[0] || spl.title.split('[')[0].trim();
          const genericName = openfda.generic_name?.[0] || '';
          const mfgFromTitle = spl.title.match(/\[([^\]]+)\]\s*$/)?.[1] || '';
          const manufacturerName = openfda.manufacturer_name?.[0] || mfgFromTitle || 'Listed Manufacturer';
          const ndcCode = openfda.product_ndc?.[0] || `DM-${spl.setid.slice(0, 8).toUpperCase()}`;
          const dosageForm = openfda.dosage_form?.[0]
            ? `${openfda.dosage_form[0]}${openfda.route?.[0] ? ` · ${openfda.route[0]}` : ''}`
            : 'See manufacturer leaflet';
          const activeIngredient =
            cleanClip(fdaDoc?.active_ingredient as string[] | undefined, 240) ||
            genericName ||
            brandName;
          const description =
            cleanClip((fdaDoc?.indications_and_usage || fdaDoc?.purpose) as string[] | undefined, 280) ||
            `Official manufacturer product record for ${brandName}.`;
          const usageDirections =
            cleanClip(fdaDoc?.dosage_and_administration as string[] | undefined, 420) ||
            'Use as directed by a licensed pharmacist or prescriber per official package insert.';
          const warnings =
            cleanClip(
              (fdaDoc?.boxed_warning || fdaDoc?.warnings || fdaDoc?.warnings_and_cautions) as
                | string[]
                | undefined,
              420
            ) || 'Read the official patient medication guide before use.';
          const storageInfo =
            cleanClip(fdaDoc?.storage_and_handling as string[] | undefined, 240) ||
            'Store at controlled room temperature 20°C to 25°C away from moisture.';
          const isOtc = (openfda.product_type?.[0] || '').toUpperCase().includes('OTC');

          results.push({
            ndcCode,
            name: brandName,
            manufacturerName,
            activeIngredient,
            dosageForm,
            description,
            usageDirections,
            warnings,
            storageInfo,
            imageUrl,
            officialSourceUrl: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${spl.setid}`,
            requiresPrescription: !isOtc,
          });
        } catch {
          // skip individual lookup error
        }
      }

      res.json({ results });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to fetch official manufacturer records.',
      });
    }
  }
);

app.post('/api/staff/inventory', requireAuth, requireRole('pharmacist', 'owner'), (req: AuthedRequest, res) => {
  const {
    ndcCode,
    name,
    category,
    description,
    imageUrl,
    manufacturerName,
    activeIngredient,
    dosageForm,
    usageDirections,
    warnings,
    storageInfo,
    officialSourceUrl,
    unitPriceCents,
    costPriceCents,
    stockQuantity,
    reorderThreshold,
    reorderQuantity,
    lotNumber,
    expiryDate,
    requiresPrescription,
  } = req.body as {
    ndcCode?: string;
    name?: string;
    category?: InventoryCategory;
    description?: string;
    imageUrl?: string | null;
    manufacturerName?: string;
    activeIngredient?: string;
    dosageForm?: string;
    usageDirections?: string;
    warnings?: string;
    storageInfo?: string;
    officialSourceUrl?: string | null;
    unitPriceCents?: number;
    costPriceCents?: number;
    stockQuantity?: number;
    reorderThreshold?: number;
    reorderQuantity?: number;
    lotNumber?: string;
    expiryDate?: string;
    requiresPrescription?: boolean;
  };

  if (!ndcCode || !name || !category) {
    res.status(400).json({ error: 'Item code, name, and category are required.' });
    return;
  }

  const validCat: InventoryCategory = INVENTORY_CATEGORIES.includes(category as InventoryCategory)
    ? (category as InventoryCategory)
    : 'Pain & Fever';
  const rxFlag =
    typeof requiresPrescription === 'boolean'
      ? requiresPrescription
        ? 1
        : 0
      : validCat === 'Chronic & Heart'
        ? 1
        : 0;
  const id = `inv_${crypto.randomUUID().slice(0, 8)}`;
  const stock = Math.max(0, Number(stockQuantity) || 20);
  const threshold = Math.max(1, Number(reorderThreshold) || 10);

  try {
    const poTriggered = runTx(() => {
      db.prepare(
        `INSERT INTO inventory (
          id, ndc_code, name, category, description, image_url,
          manufacturer_name, active_ingredient, dosage_form, usage_directions, warnings, storage_info, official_source_url,
          unit_price_cents, cost_price_cents, stock_quantity, reorder_threshold, reorder_quantity,
          lot_number, expiry_date, supplier_id, supplier_name, auto_reorder_enabled, requires_prescription
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'usr_supplier_apex', 'Ernest & Tobinko MedSupply Ghana', 1, ?)`
      ).run(
        id,
        ndcCode.trim(),
        name.trim(),
        validCat,
        (description || 'Pharmacy shelf item.').trim(),
        imageUrl ? String(imageUrl).trim() : null,
        (manufacturerName || '').trim(),
        (activeIngredient || '').trim(),
        (dosageForm || '').trim(),
        (usageDirections || '').trim(),
        (warnings || '').trim(),
        (storageInfo || '').trim(),
        sanitizeHttpsUrl(officialSourceUrl),
        Math.max(100, Number(unitPriceCents) || 2500),
        Math.max(50, Number(costPriceCents) || 1000),
        stock,
        threshold,
        Math.max(5, Number(reorderQuantity) || 30),
        (lotNumber || `LOT-${nextSequence('lot_seq', 6000)}`).trim(),
        (expiryDate || '2028-12-31').trim(),
        rxFlag
      );

      writeAuditLog(
        req.user!.uid,
        req.user!.displayName,
        req.user!.role,
        'INVENTORY_SKU_ADDED',
        'inventory',
        id,
        `Added ${name.trim()} [${validCat}] (${ndcCode.trim()}) with stock=${stock}, threshold=${threshold}.`
      );

      return checkAndTriggerAutoReplenishment(
        id,
        req.user!.uid,
        req.user!.displayName,
        req.user!.role
      );
    });

    broadcastTopics(
      poTriggered
        ? ['inventory', 'replenishments', 'analytics', 'audit']
        : ['inventory', 'analytics', 'audit']
    );
    res.status(201).json({ ok: true, id, poTriggered });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to add item.' });
  }
});

app.post('/api/staff/services', requireAuth, requireRole('pharmacist', 'owner'), (req: AuthedRequest, res) => {
  const { name, category, turnaroundMinutes, priceCents, notes } = req.body as {
    name?: string;
    category?: string;
    turnaroundMinutes?: number;
    priceCents?: number;
    notes?: string;
  };
  if (!name || !name.trim()) {
    res.status(400).json({ error: 'Service name is required.' });
    return;
  }
  const id = `srv_${crypto.randomUUID().slice(0, 8)}`;
  const cleanName = name.trim();
  const cleanCategory = (category || 'Rapid Screening').trim();
  const cleanMinutes = Math.max(1, Math.min(180, Number(turnaroundMinutes) || 10));
  const cleanPrice = Math.max(0, Math.round(Number(priceCents) || 0));
  const cleanNotes = (notes || 'Walk-in pharmacy check with pharmacist advice.').trim();

  runTx(() => {
    db.prepare(
      `INSERT INTO pharmacy_services (id, name, category, turnaround_minutes, price_cents, notes, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    ).run(id, cleanName, cleanCategory, cleanMinutes, cleanPrice, cleanNotes);

    writeAuditLog(
      req.user!.uid,
      req.user!.displayName,
      req.user!.role,
      'SERVICE_ADDED',
      'pharmacy_services',
      id,
      `Added pharmacy service ${cleanName} (GH₵${(cleanPrice / 100).toFixed(2)}).`
    );
  });

  broadcastTopics(['services', 'inventory', 'audit']);
  res.status(201).json({ ok: true, id });
});

app.patch('/api/staff/services/:id', requireAuth, requireRole('pharmacist', 'owner'), (req: AuthedRequest, res) => {
  const { priceCents, turnaroundMinutes, notes, active } = req.body as {
    priceCents?: number;
    turnaroundMinutes?: number;
    notes?: string;
    active?: boolean;
  };
  const existing = db
    .prepare('SELECT * FROM pharmacy_services WHERE id = ?')
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Pharmacy service not found.' });
    return;
  }
  const nextPrice =
    typeof priceCents === 'number' ? Math.max(0, Math.round(priceCents)) : Number(existing.price_cents);
  const nextTurnaround =
    typeof turnaroundMinutes === 'number'
      ? Math.max(1, Math.min(180, Math.round(turnaroundMinutes)))
      : Number(existing.turnaround_minutes);
  const nextNotes = notes !== undefined ? String(notes).trim() : String(existing.notes);
  const nextActive = typeof active === 'boolean' ? (active ? 1 : 0) : Number(existing.active);

  runTx(() => {
    db.prepare(
      `UPDATE pharmacy_services SET price_cents = ?, turnaround_minutes = ?, notes = ?, active = ? WHERE id = ?`
    ).run(nextPrice, nextTurnaround, nextNotes, nextActive, req.params.id);

    writeAuditLog(
      req.user!.uid,
      req.user!.displayName,
      req.user!.role,
      'SERVICE_UPDATED',
      'pharmacy_services',
      req.params.id,
      `Updated ${String(existing.name)}: GH₵${(nextPrice / 100).toFixed(2)}, active=${nextActive === 1}.`
    );
  });

  broadcastTopics(['services', 'inventory', 'audit']);
  res.json({ ok: true });
});

app.post('/api/staff/service-logs', requireAuth, requireRole('pharmacist', 'owner'), (req: AuthedRequest, res) => {
  const { serviceId, patientName, resultValue, notes } = req.body as {
    serviceId?: string;
    patientName?: string;
    resultValue?: string;
    notes?: string;
  };
  if (!serviceId || !patientName?.trim() || !resultValue?.trim()) {
    res.status(400).json({ error: 'Service, customer name, and test reading are required.' });
    return;
  }
  const service = db
    .prepare('SELECT * FROM pharmacy_services WHERE id = ?')
    .get(serviceId) as Record<string, unknown> | undefined;
  if (!service) {
    res.status(404).json({ error: 'Service not found.' });
    return;
  }

  const id = `slog_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  runTx(() => {
    db.prepare(
      `INSERT INTO service_logs (id, service_id, service_name, patient_name, result_value, notes, price_cents, recorded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      String(service.id),
      String(service.name),
      patientName.trim(),
      resultValue.trim(),
      (notes || '').trim(),
      Number(service.price_cents),
      req.user!.displayName,
      now
    );

    writeAuditLog(
      req.user!.uid,
      req.user!.displayName,
      req.user!.role,
      'SERVICE_RESULT_RECORDED',
      'service_logs',
      id,
      `Recorded ${String(service.name)} for ${patientName.trim()}: ${resultValue.trim()}.`
    );
  });

  broadcastTopics(['services', 'audit']);
  res.status(201).json({ ok: true, id });
});

app.post('/api/staff/inventory/:id/reorder', requireAuth, requireRole('pharmacist', 'owner'), (req: AuthedRequest, res) => {
  const item = db
    .prepare('SELECT * FROM inventory WHERE id = ?')
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!item) {
    res.status(404).json({ error: 'Inventory item not found.' });
    return;
  }
  const existingOpen = db
    .prepare(
      `SELECT po_number FROM replenishment_orders WHERE inventory_id = ? AND status IN ('awaiting_supplier','confirmed_scheduled','in_transit')`
    )
    .get(req.params.id) as { po_number: string } | undefined;
  if (existingOpen) {
    res.status(409).json({ error: `Open PO ${existingOpen.po_number} already exists for this item.` });
    return;
  }

  const now = new Date().toISOString();
  const poId = `po_${crypto.randomUUID().slice(0, 8)}`;
  const poNum = `PO-MAN-${nextSequence('po_seq', 3002)}`;

  runTx(() => {
    db.prepare(
      `INSERT INTO replenishment_orders (
        id, po_number, inventory_id, medication_name, ndc_code, supplier_id, supplier_name,
        requested_qty, status, auto_triggered, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_supplier', 0, ?, ?)`
    ).run(
      poId,
      poNum,
      String(item.id),
      String(item.name),
      String(item.ndc_code),
      String(item.supplier_id),
      String(item.supplier_name),
      Number(item.reorder_quantity),
      now,
      now
    );

    writeAuditLog(
      req.user!.uid,
      req.user!.displayName,
      req.user!.role,
      'MANUAL_REPLENISHMENT_PO',
      'replenishment_orders',
      poId,
      `Pharmacist triggered replenishment ${poNum} for ${String(item.name)}.`
    );
  });

  broadcastTopics(['replenishments', 'analytics', 'audit']);
  res.status(201).json({ ok: true, poNumber: poNum });
});

app.patch('/api/staff/orders/:id/status', requireAuth, requireRole('pharmacist', 'owner'), (req: AuthedRequest, res) => {
  const { status } = req.body as { status?: 'confirmed' | 'ready_for_pickup' | 'dispatched' };
  if (!status || !['confirmed', 'ready_for_pickup', 'dispatched'].includes(status)) {
    res.status(400).json({ error: 'Invalid retail order status.' });
    return;
  }
  const existing = db
    .prepare('SELECT order_number FROM otc_orders WHERE id = ?')
    .get(req.params.id) as { order_number: string } | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Order not found.' });
    return;
  }
  db.prepare('UPDATE otc_orders SET status = ? WHERE id = ?').run(status, req.params.id);
  writeAuditLog(
    req.user!.uid,
    req.user!.displayName,
    req.user!.role,
    'OTC_ORDER_UPDATED',
    'otc_orders',
    req.params.id,
    `Retail order ${existing.order_number} marked ${status}.`
  );
  broadcastTopics(['inventory', 'audit']);
  res.json({ ok: true });
});

// Read-only mirror of the /api/staff/pos/checkout totals. MUST stay in sync with
// that handler: the MoMo charge amount is later verified against checkout's
// grandTotalCents, so any divergence fails closed at checkout.
function computePosQuote(params: {
  otcItems?: Array<{ inventoryId: string; quantity: number }>;
  prescriptionIds?: string[];
  serviceItems?: Array<{ serviceId: string; quantity: number }>;
  discountPercent?: number;
}): { grandTotalCents: number; breakdown: Record<string, number> } {
  const safeOtcItems = Array.isArray(params.otcItems) ? params.otcItems : [];
  const safeRxIds = Array.isArray(params.prescriptionIds) ? params.prescriptionIds : [];
  const safeServiceItems = Array.isArray(params.serviceItems) ? params.serviceItems : [];
  const discountPct = Math.max(0, Math.min(25, Number(params.discountPercent) || 0));

  let otcSubtotalCents = 0;
  for (const reqItem of safeOtcItems) {
    const qty = Math.max(1, Math.min(50, Math.floor(Number(reqItem.quantity) || 1)));
    const invRow = db
      .prepare('SELECT * FROM inventory WHERE id = ? AND requires_prescription = 0')
      .get(reqItem.inventoryId) as Record<string, unknown> | undefined;
    if (!invRow) {
      throw new Error('Counter shelf item not found.');
    }
    const currentStock = Number(invRow.stock_quantity);
    if (currentStock < qty) {
      throw new Error(`Insufficient stock for ${String(invRow.name)} (${currentStock} left).`);
    }
    otcSubtotalCents += Number(invRow.unit_price_cents) * qty;
  }

  const discountCents = Math.round(otcSubtotalCents * (discountPct / 100));
  const discountedOtcSubtotal = Math.max(0, otcSubtotalCents - discountCents);
  const taxCents = Math.round(discountedOtcSubtotal * 0.15);
  const otcTotalCents = discountedOtcSubtotal + taxCents;

  let rxCopayTotalCents = 0;
  for (const rxId of safeRxIds) {
    const rx = db
      .prepare('SELECT * FROM prescriptions WHERE id = ?')
      .get(rxId) as Record<string, unknown> | undefined;
    if (!rx) {
      throw new Error('Selected prescription was not found.');
    }
    if (rx.status === 'dispensed') {
      throw new Error(`${String(rx.rx_number)} is already dispensed.`);
    }
    const inv = db
      .prepare('SELECT * FROM inventory WHERE id = ?')
      .get(String(rx.inventory_id)) as Record<string, unknown> | undefined;
    if (!inv || Number(inv.stock_quantity) < 1) {
      throw new Error(`Cannot dispense ${String(rx.medication_name)}: out of stock.`);
    }
    const claim = db
      .prepare('SELECT * FROM insurance_claims WHERE prescription_id = ?')
      .get(rxId) as Record<string, unknown> | undefined;
    rxCopayTotalCents +=
      claim && (claim.claim_status === 'adjudicated' || claim.claim_status === 'paid')
        ? Number(claim.patient_copay_cents)
        : Number(rx.unit_price_cents);
  }

  let serviceTotalCents = 0;
  for (const reqSrv of safeServiceItems) {
    const qty = Math.max(1, Math.min(20, Math.floor(Number(reqSrv.quantity) || 1)));
    const srvRow = db
      .prepare('SELECT * FROM pharmacy_services WHERE id = ? AND active = 1')
      .get(reqSrv.serviceId) as Record<string, unknown> | undefined;
    if (!srvRow) {
      throw new Error('Selected pharmacy service was not found or is paused.');
    }
    serviceTotalCents += Number(srvRow.price_cents) * qty;
  }

  const grandTotalCents = otcTotalCents + rxCopayTotalCents + serviceTotalCents;
  return {
    grandTotalCents,
    breakdown: { otcTotalCents, rxCopayTotalCents, serviceTotalCents },
  };
}

const MOMO_PROVIDERS = new Set(['mtn', 'atl', 'vod']);

// Staff-initiated MoMo charge: sends a USSD prompt to the customer's phone for the
// server-computed bill total. The customer must approve within ~180s; staff then
// poll the status endpoint and complete checkout with the returned reference.
app.post(
  '/api/staff/pos/payment-requests',
  requireAuth,
  requireRole('pharmacist', 'owner'),
  async (req: AuthedRequest, res) => {
    const {
      customerPhone,
      momoProvider,
      customerEmail,
      discountPercent,
      otcItems,
      prescriptionIds,
      serviceItems,
    } = req.body as {
      customerPhone?: string;
      momoProvider?: string;
      customerEmail?: string;
      discountPercent?: number;
      otcItems?: Array<{ inventoryId: string; quantity: number }>;
      prescriptionIds?: string[];
      serviceItems?: Array<{ serviceId: string; quantity: number }>;
    };

    const phone = String(customerPhone || '').replace(/[\s-]/g, '');
    const provider = String(momoProvider || '').trim().toLowerCase();
    if (!/^\+?\d{9,15}$/.test(phone)) {
      res.status(400).json({ error: 'A valid customer MoMo phone number is required.' });
      return;
    }
    if (!MOMO_PROVIDERS.has(provider)) {
      res.status(400).json({ error: 'MoMo provider must be mtn, atl, or vod.' });
      return;
    }

    let quote: { grandTotalCents: number; breakdown: Record<string, number> };
    try {
      quote = computePosQuote({ otcItems, prescriptionIds, serviceItems, discountPercent });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to price this sale.' });
      return;
    }
    if (quote.grandTotalCents <= 0) {
      res.status(400).json({ error: 'Order total must be greater than zero.' });
      return;
    }

    const secret = process.env.PAYSTACK_SECRET_KEY?.trim();
    if (!secret) {
      res.status(503).json({ error: 'Online payment is not configured.' });
      return;
    }

    const reference = `pos_${crypto.randomUUID()}`;
    try {
      const response = await fetch('https://api.paystack.co/charge', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          email: (customerEmail || 'counter@netanyarx.local').trim() || 'counter@netanyarx.local',
          amount: quote.grandTotalCents,
          currency: 'GHS',
          reference,
          mobile_money: { phone, provider },
        }),
      });
      const payload = await response.json() as {
        status?: boolean;
        message?: string;
        data?: { status?: string; reference?: string; display_text?: string };
      };
      if (!response.ok || !payload.status || !payload.data) {
        res.status(502).json({ error: payload.message || 'Unable to send payment prompt.' });
        return;
      }

      const chargeStatus = String(payload.data.status || 'pending');
      const storedStatus =
        chargeStatus === 'success' ? 'success' : chargeStatus === 'failed' || chargeStatus === 'abandoned' ? 'failed' : 'pending';
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE pos_payment_requests SET status = 'superseded', resolved_at = ?
         WHERE created_by = ? AND status = 'pending'`
      ).run(now, req.user!.uid);
      db.prepare(
        `INSERT INTO pos_payment_requests (
          reference, grand_total_cents, status, created_by, created_by_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        reference,
        quote.grandTotalCents,
        storedStatus,
        req.user!.uid,
        req.user!.displayName,
        now
      );

      writeAuditLog(
        req.user!.uid,
        req.user!.displayName,
        req.user!.role,
        'POS_MOMO_CHARGE_INITIATED',
        'pos_payment_requests',
        reference,
        `MoMo payment prompt sent via ${provider} for GH₵${(quote.grandTotalCents / 100).toFixed(2)}.`
      );

      res.status(201).json({
        reference,
        status: chargeStatus,
        grandTotalCents: quote.grandTotalCents,
        displayText: payload.data.display_text || null,
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Unable to send payment prompt.' });
    }
  }
);

app.get(
  '/api/staff/pos/payment-requests/:reference',
  requireAuth,
  requireRole('pharmacist', 'owner'),
  async (req: AuthedRequest, res) => {
    const row = db
      .prepare('SELECT * FROM pos_payment_requests WHERE reference = ?')
      .get(req.params.reference) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: 'Payment request not found.' });
      return;
    }

    let status = String(row.status);
    if (status === 'pending') {
      const ageMs = Date.now() - new Date(String(row.created_at)).getTime();
      if (ageMs > 10 * 60 * 1000) {
        status = 'expired';
      } else {
        try {
          const txn = await fetchPaystackTransaction(String(row.reference));
          if (txn.status === 'success' && txn.currency === 'GHS' && txn.amountCents === Number(row.grand_total_cents)) {
            status = 'success';
          } else if (txn.status === 'failed' || txn.status === 'reversed') {
            status = 'failed';
          }
        } catch {
          // Paystack unreachable — report current stored status.
        }
      }
      if (status !== String(row.status)) {
        db.prepare('UPDATE pos_payment_requests SET status = ?, resolved_at = ? WHERE reference = ?').run(
          status,
          status === 'pending' ? null : new Date().toISOString(),
          String(row.reference)
        );
      }
    }

    res.json({
      reference: String(row.reference),
      status,
      grandTotalCents: Number(row.grand_total_cents),
    });
  }
);

app.post('/api/staff/pos/checkout', requireAuth, requireRole('pharmacist', 'owner'), async (req: AuthedRequest, res) => {
  const {
    customerName,
    customerEmail,
    paymentMethod,
    tenderedCents,
    discountPercent,
    otcItems,
    prescriptionIds,
    serviceItems,
    hardwareTransport,
    paymentReference,
  } = req.body as {
    customerName?: string;
    customerEmail?: string;
    paymentMethod?: 'cash' | 'card' | 'mobile_pay';
    tenderedCents?: number;
    discountPercent?: number;
    otcItems?: Array<{ inventoryId: string; quantity: number }>;
    prescriptionIds?: string[];
    serviceItems?: Array<{ serviceId: string; quantity: number }>;
    hardwareTransport?: string;
    paymentReference?: string;
  };

  const safeOtcItems = Array.isArray(otcItems) ? otcItems : [];
  const safeRxIds = Array.isArray(prescriptionIds) ? prescriptionIds : [];
  const safeServiceItems = Array.isArray(serviceItems) ? serviceItems : [];

  if (safeOtcItems.length === 0 && safeRxIds.length === 0 && safeServiceItems.length === 0) {
    res.status(400).json({
      error: 'Add at least one counter item, test/service, or ready prescription to complete sale.',
    });
    return;
  }

  const cleanName = (customerName || 'Walk-In Customer').trim() || 'Walk-In Customer';
  const cleanEmail = (customerEmail || 'counter@netanyarx.local').trim() || 'counter@netanyarx.local';
  const method =
    paymentMethod === 'cash' || paymentMethod === 'mobile_pay' ? paymentMethod : 'card';
  const discountPct = Math.max(0, Math.min(25, Number(discountPercent) || 0));

  const paymentRef = String(paymentReference || '').trim();
  let posPayment: PaystackPayment | null = null;
  if (method !== 'cash') {
    try {
      posPayment = await fetchPaystackPayment(paymentRef);
    } catch (err) {
      res.status(402).json({
        error: err instanceof Error ? err.message : 'A successful electronic payment is required.',
      });
      return;
    }
  }

  try {
    const result = runTx(() => {
      const resolvedOtc: OtcOrderItem[] = [];
      let otcSubtotalCents = 0;
      let poTriggered = false;

      for (const reqItem of safeOtcItems) {
        const qty = Math.max(1, Math.min(50, Math.floor(Number(reqItem.quantity) || 1)));
        const invRow = db
          .prepare('SELECT * FROM inventory WHERE id = ? AND requires_prescription = 0')
          .get(reqItem.inventoryId) as Record<string, unknown> | undefined;

        if (!invRow) {
          throw new Error('Counter shelf item not found.');
        }
        const currentStock = Number(invRow.stock_quantity);
        if (currentStock < qty) {
          throw new Error(`Insufficient stock for ${String(invRow.name)} (${currentStock} left).`);
        }

        const newStock = currentStock - qty;
        db.prepare('UPDATE inventory SET stock_quantity = ? WHERE id = ?').run(
          newStock,
          String(invRow.id)
        );

        const unitPriceCents = Number(invRow.unit_price_cents);
        otcSubtotalCents += unitPriceCents * qty;
        resolvedOtc.push({
          inventoryId: String(invRow.id),
          name: String(invRow.name),
          quantity: qty,
          unitPriceCents,
        });

        if (
          checkAndTriggerAutoReplenishment(
            String(invRow.id),
            req.user!.uid,
            req.user!.displayName,
            req.user!.role
          )
        ) {
          poTriggered = true;
        }
      }

      const discountCents = Math.round(otcSubtotalCents * (discountPct / 100));
      const discountedOtcSubtotal = Math.max(0, otcSubtotalCents - discountCents);
      const taxCents = Math.round(discountedOtcSubtotal * 0.15);
      const otcTotalCents = discountedOtcSubtotal + taxCents;

      const rxLines: Array<{
        prescriptionId: string;
        rxNumber: string;
        patientName: string;
        medicationName: string;
        copayCents: number;
      }> = [];
      let rxCopayTotalCents = 0;
      const now = new Date().toISOString();

      for (const rxId of safeRxIds) {
        const rx = db
          .prepare('SELECT * FROM prescriptions WHERE id = ?')
          .get(rxId) as Record<string, unknown> | undefined;
        if (!rx) {
          throw new Error('Selected prescription was not found.');
        }
        const claim = getDispensingClaim(rx);

        const inv = db
          .prepare('SELECT * FROM inventory WHERE id = ?')
          .get(String(rx.inventory_id)) as Record<string, unknown> | undefined;
        if (!inv || Number(inv.stock_quantity) < 1) {
          throw new Error(`Cannot dispense ${String(rx.medication_name)}: out of stock.`);
        }

        db.prepare('UPDATE inventory SET stock_quantity = stock_quantity - 1 WHERE id = ?').run(
          String(inv.id)
        );
        const nextRefillDate = new Date(
          Date.now() + Math.max(1, Math.floor(Number(rx.days_supply) * 0.75)) * 86400000
        ).toISOString();
        db.prepare(
          `UPDATE prescriptions SET status = 'dispensed', next_refill_eligible_at = ?, updated_at = ? WHERE id = ?`
        ).run(nextRefillDate, now, rxId);

        let copayCents = Number(rx.unit_price_cents);
        if (claim && (claim.claim_status === 'adjudicated' || claim.claim_status === 'paid')) {
          copayCents = Number(claim.patient_copay_cents);
          db.prepare(
            `UPDATE insurance_claims SET claim_status = 'paid', updated_at = ? WHERE id = ?`
          ).run(now, String(claim.id));
        }

        rxCopayTotalCents += copayCents;
        rxLines.push({
          prescriptionId: rxId,
          rxNumber: String(rx.rx_number),
          patientName: String(rx.patient_name),
          medicationName: String(rx.medication_name),
          copayCents,
        });

        if (
          checkAndTriggerAutoReplenishment(
            String(inv.id),
            req.user!.uid,
            req.user!.displayName,
            req.user!.role
          )
        ) {
          poTriggered = true;
        }
      }

      const serviceLines: Array<{
        serviceId: string;
        name: string;
        quantity: number;
        priceCents: number;
      }> = [];
      let serviceTotalCents = 0;

      for (const reqSrv of safeServiceItems) {
        const qty = Math.max(1, Math.min(20, Math.floor(Number(reqSrv.quantity) || 1)));
        const srvRow = db
          .prepare('SELECT * FROM pharmacy_services WHERE id = ? AND active = 1')
          .get(reqSrv.serviceId) as Record<string, unknown> | undefined;
        if (!srvRow) {
          throw new Error('Selected pharmacy service was not found or is paused.');
        }
        const priceCents = Number(srvRow.price_cents);
        serviceTotalCents += priceCents * qty;
        serviceLines.push({
          serviceId: String(srvRow.id),
          name: String(srvRow.name),
          quantity: qty,
          priceCents,
        });
      }

      const receiptNumber = `POS-${nextSequence('pos_seq', 10000)}`;
      const orderId = `pos_${crypto.randomUUID().slice(0, 8)}`;

      for (const sl of serviceLines) {
        db.prepare(
          `INSERT INTO service_logs (id, service_id, service_name, patient_name, result_value, notes, price_cents, recorded_by, created_at)
           VALUES (?, ?, ?, ?, 'Paid at counter', ?, ?, ?, ?)`
        ).run(
          `slog_${crypto.randomUUID().slice(0, 8)}`,
          sl.serviceId,
          sl.name,
          cleanName,
          `Receipt ${receiptNumber}${sl.quantity > 1 ? ` (×${sl.quantity})` : ''}`,
          sl.priceCents * sl.quantity,
          req.user!.displayName,
          now
        );
      }

      const grandTotalCents = otcTotalCents + rxCopayTotalCents + serviceTotalCents;
      const actualTenderedCents =
        method === 'cash'
          ? (Number(tenderedCents) || grandTotalCents)
          : grandTotalCents;
      if (method === 'cash' && actualTenderedCents < grandTotalCents) {
        throw new Error('Cash received is less than the total due.');
      }
      const changeDueCents = method === 'cash' ? Math.max(0, actualTenderedCents - grandTotalCents) : 0;

      if (method !== 'cash') {
        if (posPayment!.amountCents !== grandTotalCents) {
          throw new Error('Electronic payment amount does not match the order total.');
        }
        const claimedPayment = db
          .prepare('SELECT reference FROM payment_references WHERE reference = ?')
          .get(paymentRef);
        if (claimedPayment) {
          throw new Error('This payment has already been used for a sale.');
        }
        db.prepare(
          'INSERT INTO payment_references (reference, amount_cents, created_at) VALUES (?, ?, ?)'
        ).run(paymentRef, grandTotalCents, now);
      }

      db.prepare(
        `INSERT INTO pos_transactions (
          id, receipt_number, cashier_id, cashier_name, customer_name, customer_email,
          payment_method, discount_percent, otc_lines_json, rx_lines_json, service_lines_json,
          subtotal_cents, discount_cents, tax_cents, rx_copay_total_cents, service_total_cents,
          grand_total_cents, tendered_cents, change_due_cents, payment_reference, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        orderId,
        receiptNumber,
        req.user!.uid,
        req.user!.displayName,
        cleanName,
        cleanEmail,
        method,
        discountPct,
        JSON.stringify(resolvedOtc),
        JSON.stringify(rxLines),
        JSON.stringify(serviceLines),
        otcSubtotalCents,
        discountCents,
        taxCents,
        rxCopayTotalCents,
        serviceTotalCents,
        grandTotalCents,
        actualTenderedCents,
        changeDueCents,
        method === 'cash' ? '' : paymentRef,
        now
      );

      if (resolvedOtc.length > 0) {
        db.prepare(
          `INSERT INTO otc_orders (
            id, order_number, customer_name, customer_email, fulfillment_type, shipping_address,
            items_json, subtotal_cents, tax_cents, total_cents, status, created_at
          ) VALUES (?, ?, ?, ?, 'pickup', ?, ?, ?, ?, ?, 'dispatched', ?)`
        ).run(
          orderId,
          receiptNumber,
          cleanName,
          cleanEmail,
          `Walk-In Counter POS · ${method === 'mobile_pay' ? 'MOMO/GHQR' : method.toUpperCase()}`,
          JSON.stringify(resolvedOtc),
          discountedOtcSubtotal,
          taxCents,
          otcTotalCents,
          now
        );
      }

      writeAuditLog(
        req.user!.uid,
        req.user!.displayName,
        req.user!.role,
        'POS_COUNTER_SALE',
        'pos_transactions',
        orderId,
        `Walk-in counter sale ${receiptNumber} (${method === 'mobile_pay' ? 'MOMO/GHQR' : method.toUpperCase()}) for ${cleanName}: ${resolvedOtc.length} OTC item(s), ${serviceLines.length} test/service(s), ${rxLines.length} Rx copay(s), total GH₵${(grandTotalCents / 100).toFixed(2)}.`
      );

      let drawerEvent: CashDrawerEvent | null = null;
      if (method === 'cash') {
        const transport = String(hardwareTransport || 'system_counter').slice(0, 40);
        drawerEvent = recordCashDrawerEvent({
          actorId: req.user!.uid,
          actorName: req.user!.displayName,
          actorRole: req.user!.role,
          triggerType: 'cash_sale',
          reason: `Cash payment collected (${receiptNumber})`,
          receiptNumber,
          hardwareTransport: transport,
          authorizedAt: now,
        });
        writeAuditLog(
          req.user!.uid,
          req.user!.displayName,
          req.user!.role,
          'CASH_DRAWER_OPENED',
          'cash_drawer_events',
          drawerEvent.id,
          `Authorized cash drawer kick for ${receiptNumber} (tendered GH₵${(actualTenderedCents / 100).toFixed(2)}, change GH₵${(changeDueCents / 100).toFixed(2)}).`
        );
      }

      return {
        receipt: {
          receiptNumber,
          customerName: cleanName,
          cashierName: req.user!.displayName,
          paymentMethod: method,
          discountPercent: discountPct,
          otcLines: resolvedOtc,
          rxLines,
          serviceLines,
          subtotalCents: otcSubtotalCents,
          discountCents,
          taxCents,
          rxCopayTotalCents,
          serviceTotalCents,
          grandTotalCents,
          tenderedCents: actualTenderedCents,
          changeDueCents,
          poTriggered,
          createdAt: now,
        },
        poTriggered,
        drawerAuthorized: method === 'cash',
        drawerEvent,
      };
    });

    broadcastTopics(
      result.poTriggered
        ? ['inventory', 'services', 'prescriptions', 'claims', 'replenishments', 'analytics', 'audit']
        : ['inventory', 'services', 'prescriptions', 'claims', 'analytics', 'audit']
    );
    res.status(201).json({
      receipt: result.receipt,
      drawerAuthorized: result.drawerAuthorized,
      drawerEvent: result.drawerEvent,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Counter sale failed.' });
  }
});

app.get('/api/staff/peripherals/drawer/logs', requireAuth, requireRole('pharmacist', 'owner'), (_req, res) => {
  const rows = db
    .prepare('SELECT * FROM cash_drawer_events ORDER BY authorized_at DESC LIMIT 40')
    .all() as Record<string, unknown>[];
  res.json({ events: rows.map(mapDrawerEventRow) });
});

app.post('/api/staff/peripherals/drawer/open', requireAuth, requireRole('pharmacist', 'owner'), (req: AuthedRequest, res) => {
  const { password, authorizerEmail, triggerType, reason, hardwareTransport } = req.body as {
    password?: string;
    authorizerEmail?: string;
    triggerType?: CashDrawerTrigger;
    reason?: string;
    hardwareTransport?: string;
  };

  if (!password || typeof password !== 'string') {
    res.status(400).json({ error: 'Authorized staff password is required to unlock the cash drawer.' });
    return;
  }

  const targetUser = authorizerEmail?.trim()
    ? (db
        .prepare('SELECT id, email, password_hash, display_name, role FROM users WHERE LOWER(email) = LOWER(?)')
        .get(authorizerEmail.trim()) as
        | { id: string; email: string; password_hash: string; display_name: string; role: UserRole }
        | undefined)
    : (db
        .prepare('SELECT id, email, password_hash, display_name, role FROM users WHERE id = ?')
        .get(req.user!.uid) as
        | { id: string; email: string; password_hash: string; display_name: string; role: UserRole }
        | undefined);

  if (!targetUser || (targetUser.role !== 'pharmacist' && targetUser.role !== 'owner')) {
    res.status(403).json({ error: 'Only an authorized pharmacist or owner can open the cash drawer.' });
    return;
  }

  if (!verifyPassword(password, targetUser.password_hash)) {
    writeAuditLog(
      req.user!.uid,
      req.user!.displayName,
      req.user!.role,
      'CASH_DRAWER_AUTH_FAILED',
      'cash_drawer_events',
      targetUser.id,
      `Denied manual cash drawer open attempt for ${targetUser.display_name} due to invalid password.`
    );
    res.status(401).json({ error: 'Invalid password. Cash drawer remains locked.' });
    return;
  }

  const allowedTriggers: CashDrawerTrigger[] = ['manual_no_sale', 'cash_drop', 'shift_count', 'refund'];
  const safeTrigger: CashDrawerTrigger = allowedTriggers.includes(triggerType as CashDrawerTrigger)
    ? (triggerType as CashDrawerTrigger)
    : 'manual_no_sale';

  const triggerLabels: Record<CashDrawerTrigger, string> = {
    cash_sale: 'Cash sale payment',
    manual_no_sale: 'No-sale change / counter access',
    cash_drop: 'Cash drop to safe',
    shift_count: 'Shift cash reconciliation count',
    refund: 'Authorized customer cash refund',
  };

  const cleanReason = (reason || '').trim() || triggerLabels[safeTrigger];
  const transport = String(hardwareTransport || 'escpos_pulse').slice(0, 40);

  const event = runTx(() => {
    const ev = recordCashDrawerEvent({
      actorId: targetUser.id,
      actorName: targetUser.display_name,
      actorRole: targetUser.role,
      triggerType: safeTrigger,
      reason: cleanReason,
      receiptNumber: null,
      hardwareTransport: transport,
    });
    writeAuditLog(
      targetUser.id,
      targetUser.display_name,
      targetUser.role,
      'CASH_DRAWER_AUTHORIZED_OPEN',
      'cash_drawer_events',
      ev.id,
      `Unlocked cash drawer (${safeTrigger}): ${cleanReason} [via ${transport}].`
    );
    return ev;
  });

  broadcastTopics(['audit', 'inventory']);
  res.json({ ok: true, drawerAuthorized: true, event });
});

app.post('/api/staff/peripherals/receipt-print', requireAuth, requireRole('pharmacist', 'owner'), (req: AuthedRequest, res) => {
  const { receiptNumber, transport } = req.body as { receiptNumber?: string; transport?: string };
  if (!receiptNumber) {
    res.status(400).json({ error: 'receiptNumber is required.' });
    return;
  }
  writeAuditLog(
    req.user!.uid,
    req.user!.displayName,
    req.user!.role,
    'POS_RECEIPT_PRINTED',
    'pos_transactions',
    receiptNumber,
    `Printed receipt ${receiptNumber} via ${String(transport || 'system_printer')}.`
  );
  broadcastTopics(['audit']);
  res.json({ ok: true });
});

app.patch('/api/staff/prescriptions/:id/status', requireAuth, requireRole('pharmacist', 'owner'), (req: AuthedRequest, res) => {
  const { status } = req.body as { status?: PrescriptionStatus };
  const allowed: PrescriptionStatus[] = ['submitted', 'verifying', 'insurance_hold', 'ready', 'dispensed'];
  if (!status || !allowed.includes(status)) {
    res.status(400).json({ error: 'Invalid prescription status.' });
    return;
  }

  const rx = db
    .prepare('SELECT * FROM prescriptions WHERE id = ?')
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!rx) {
    res.status(404).json({ error: 'Prescription not found.' });
    return;
  }
  if (rx.status === 'dispensed' && status !== 'dispensed') {
    res.status(400).json({ error: 'A dispensed prescription cannot be moved back to another status.' });
    return;
  }

  try {
    const result = runTx(() => {
      const now = new Date().toISOString();
      let poTriggered = false;

      if (status === 'dispensed' && rx.status !== 'dispensed') {
        getDispensingClaim(rx);
        const inv = db
          .prepare('SELECT * FROM inventory WHERE id = ?')
          .get(String(rx.inventory_id)) as Record<string, unknown> | undefined;

        if (!inv || Number(inv.stock_quantity) < 1) {
          throw new Error('Cannot dispense: item out of stock in dispensary.');
        }

        const newStock = Math.max(0, Number(inv.stock_quantity) - 1);
        db.prepare('UPDATE inventory SET stock_quantity = ? WHERE id = ?').run(
          newStock,
          String(inv.id)
        );

        const nextRefillDate = new Date(
          Date.now() + Math.max(1, Math.floor(Number(rx.days_supply) * 0.75)) * 86400000
        ).toISOString();

        db.prepare(
          'UPDATE prescriptions SET status = ?, next_refill_eligible_at = ?, updated_at = ? WHERE id = ?'
        ).run(status, nextRefillDate, now, req.params.id);

        db.prepare(
          `UPDATE insurance_claims SET claim_status = 'paid', updated_at = ? WHERE prescription_id = ? AND claim_status = 'adjudicated'`
        ).run(now, req.params.id);

        poTriggered = checkAndTriggerAutoReplenishment(
          String(inv.id),
          req.user!.uid,
          req.user!.displayName,
          req.user!.role
        );
      } else {
        db.prepare('UPDATE prescriptions SET status = ?, updated_at = ? WHERE id = ?').run(
          status,
          now,
          req.params.id
        );
      }

      writeAuditLog(
        req.user!.uid,
        req.user!.displayName,
        req.user!.role,
        `RX_STATUS_${status.toUpperCase()}`,
        'prescriptions',
        req.params.id,
        `Updated ${String(rx.rx_number)} (${String(rx.medication_name)}) to ${status}.`
      );

      return { poTriggered };
    });

    broadcastTopics(
      result.poTriggered
        ? ['prescriptions', 'inventory', 'claims', 'replenishments', 'analytics', 'audit']
        : ['prescriptions', 'inventory', 'claims', 'analytics', 'audit']
    );
    res.json({ ok: true, status });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Status update failed.' });
  }
});

app.post('/api/staff/care-plans', requireAuth, requireRole('pharmacist', 'owner'), (req: AuthedRequest, res) => {
  const { patientId, conditionFocus, clinicalGoals, interactionWarnings, adherenceNotes, followUpDate } =
    req.body as {
      patientId?: string;
      conditionFocus?: string;
      clinicalGoals?: string;
      interactionWarnings?: string;
      adherenceNotes?: string;
      followUpDate?: string;
    };

  if (!patientId || !conditionFocus || !clinicalGoals) {
    res.status(400).json({ error: 'Patient, condition focus, and clinical goals are required.' });
    return;
  }

  const patient = db
    .prepare('SELECT id, display_name FROM users WHERE id = ? AND role = ?')
    .get(patientId, 'patient') as { id: string; display_name: string } | undefined;
  if (!patient) {
    res.status(404).json({ error: 'Patient record not found.' });
    return;
  }

  const id = `cp_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  runTx(() => {
    db.prepare(
      `INSERT INTO care_plans (id, patient_id, patient_name, pharmacist_name, condition_focus, clinical_goals, interaction_warnings, adherence_notes, follow_up_date, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      patient.id,
      patient.display_name,
      req.user!.displayName,
      conditionFocus.trim(),
      clinicalGoals.trim(),
      (interactionWarnings || 'None noted').trim(),
      (adherenceNotes || '').trim(),
      followUpDate || now.slice(0, 10),
      now
    );

    writeAuditLog(
      req.user!.uid,
      req.user!.displayName,
      req.user!.role,
      'CARE_PLAN_CREATED',
      'care_plans',
      id,
      `Created clinical care plan for ${patient.display_name} (${conditionFocus.trim()}).`
    );
  });

  broadcastTopics(['prescriptions', 'audit']);
  res.status(201).json({ ok: true, id });
});

app.patch('/api/staff/care-plans/:id', requireAuth, requireRole('pharmacist', 'owner'), (req: AuthedRequest, res) => {
  const { clinicalGoals, interactionWarnings, adherenceNotes, followUpDate } = req.body as {
    clinicalGoals?: string;
    interactionWarnings?: string;
    adherenceNotes?: string;
    followUpDate?: string;
  };
  const existing = db
    .prepare('SELECT * FROM care_plans WHERE id = ?')
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Care plan not found.' });
    return;
  }

  const now = new Date().toISOString();
  runTx(() => {
    db.prepare(
      `UPDATE care_plans SET clinical_goals = ?, interaction_warnings = ?, adherence_notes = ?, follow_up_date = ?, updated_at = ? WHERE id = ?`
    ).run(
      clinicalGoals ?? String(existing.clinical_goals),
      interactionWarnings ?? String(existing.interaction_warnings),
      adherenceNotes ?? String(existing.adherence_notes),
      followUpDate ?? String(existing.follow_up_date),
      now,
      req.params.id
    );

    writeAuditLog(
      req.user!.uid,
      req.user!.displayName,
      req.user!.role,
      'CARE_PLAN_UPDATED',
      'care_plans',
      req.params.id,
      `Updated clinical care plan for ${String(existing.patient_name)}.`
    );
  });

  broadcastTopics(['prescriptions', 'audit']);
  res.json({ ok: true });
});

app.patch('/api/staff/inventory/:id', requireAuth, requireRole('pharmacist', 'owner'), (req: AuthedRequest, res) => {
  const { stockQuantity, reorderThreshold, reorderQuantity, autoReorderEnabled, lotNumber, expiryDate } =
    req.body as {
      stockQuantity?: number;
      reorderThreshold?: number;
      reorderQuantity?: number;
      autoReorderEnabled?: boolean;
      lotNumber?: string;
      expiryDate?: string;
    };

  const existing = db
    .prepare('SELECT * FROM inventory WHERE id = ?')
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Inventory item not found.' });
    return;
  }

  const nextStock =
    typeof stockQuantity === 'number' ? Math.max(0, Math.floor(stockQuantity)) : Number(existing.stock_quantity);
  const nextThreshold =
    typeof reorderThreshold === 'number'
      ? Math.max(1, Math.floor(reorderThreshold))
      : Number(existing.reorder_threshold);
  const nextReorderQty =
    typeof reorderQuantity === 'number'
      ? Math.max(1, Math.floor(reorderQuantity))
      : Number(existing.reorder_quantity);
  const nextAuto =
    typeof autoReorderEnabled === 'boolean'
      ? autoReorderEnabled
        ? 1
        : 0
      : Number(existing.auto_reorder_enabled);

  const poTriggered = runTx(() => {
    db.prepare(
      `UPDATE inventory SET stock_quantity = ?, reorder_threshold = ?, reorder_quantity = ?, auto_reorder_enabled = ?, lot_number = ?, expiry_date = ? WHERE id = ?`
    ).run(
      nextStock,
      nextThreshold,
      nextReorderQty,
      nextAuto,
      lotNumber || String(existing.lot_number),
      expiryDate || String(existing.expiry_date),
      req.params.id
    );

    writeAuditLog(
      req.user!.uid,
      req.user!.displayName,
      req.user!.role,
      'INVENTORY_UPDATED',
      'inventory',
      req.params.id,
      `Adjusted ${String(existing.name)} stock=${nextStock}, alert threshold=${nextThreshold}.`
    );

    return checkAndTriggerAutoReplenishment(
      req.params.id,
      req.user!.uid,
      req.user!.displayName,
      req.user!.role
    );
  });

  broadcastTopics(
    poTriggered
      ? ['inventory', 'replenishments', 'analytics', 'audit']
      : ['inventory', 'analytics', 'audit']
  );
  res.json({ ok: true, poTriggered });
});

app.post('/api/staff/claims/adjudicate', requireAuth, requireRole('pharmacist', 'owner'), (req: AuthedRequest, res) => {
  if (!isRecord(req.body)) {
    res.status(400).json({ error: 'A valid claim request is required.' });
    return;
  }

  const {
    prescriptionId,
    planId,
    formularyTier,
    dawCode,
    overrideCode,
    overrideNotes,
  } = req.body;

  if (
    typeof prescriptionId !== 'string' ||
    !prescriptionId.trim() ||
    typeof planId !== 'string' ||
    !planId.trim()
  ) {
    res.status(400).json({ error: 'Prescription and insurance scheme are required.' });
    return;
  }
  if (!isFormularyTier(formularyTier)) {
    res.status(400).json({ error: 'Formulary tier must be 1, 2, or 3.' });
    return;
  }
  if (!isDawCode(dawCode)) {
    res.status(400).json({ error: 'DAW code must be 0, 1, or 2.' });
    return;
  }
  if (
    (overrideCode !== undefined && typeof overrideCode !== 'string') ||
    (overrideNotes !== undefined && typeof overrideNotes !== 'string')
  ) {
    res.status(400).json({ error: 'Override code and pharmacist note must be text.' });
    return;
  }

  const cleanPrescriptionId = prescriptionId.trim();
  const cleanPlanId = planId.trim();
  const cleanOverrideCode = (overrideCode || '').trim().toUpperCase();
  const cleanOverrideNotes = (overrideNotes || '').trim();
  if (cleanOverrideNotes.length > 500) {
    res.status(400).json({ error: 'Pharmacist note must be 500 characters or fewer.' });
    return;
  }
  if (Boolean(cleanOverrideCode) !== Boolean(cleanOverrideNotes)) {
    res.status(400).json({ error: 'An override code and its pharmacist note must be provided together.' });
    return;
  }

  const rx = db
    .prepare('SELECT * FROM prescriptions WHERE id = ?')
    .get(cleanPrescriptionId) as Record<string, unknown> | undefined;
  const planRow = db
    .prepare('SELECT * FROM insurance_plans WHERE id = ?')
    .get(cleanPlanId) as Record<string, unknown> | undefined;

  if (!rx || !planRow) {
    res.status(404).json({ error: 'Prescription or insurance scheme not found.' });
    return;
  }

  const phiRow = db
    .prepare('SELECT encrypted_payload FROM patients_phi WHERE user_id = ?')
    .get(String(rx.patient_id)) as { encrypted_payload: string } | undefined;
  const patientInsurance = safeDecryptPHI(phiRow?.encrypted_payload);
  if (!patientInsurance) {
    res.status(409).json({ error: 'Patient insurance details are unavailable; update the profile before adjudication.' });
    return;
  }

  const patientBin = typeof patientInsurance.bin === 'string' ? patientInsurance.bin.trim() : '';
  const patientPcn = typeof patientInsurance.pcn === 'string' ? patientInsurance.pcn.trim() : '';
  const groupId = typeof patientInsurance.groupNumber === 'string'
    ? patientInsurance.groupNumber.trim()
    : '';
  const planBin = String(planRow.bin);
  const planPcn = String(planRow.pcn);
  if (patientBin !== planBin || patientPcn !== planPcn) {
    res.status(409).json({ error: 'Selected scheme does not match the patient’s saved insurance details.' });
    return;
  }
  const groupPrefix = String(planRow.group_prefix).trim();
  if (!groupId) {
    res.status(409).json({ error: 'Patient group details are missing; update the insurance profile before adjudication.' });
    return;
  }
  if (!groupPrefix) {
    res.status(409).json({ error: 'Selected scheme is missing group validation details.' });
    return;
  }
  if (!groupId.toUpperCase().startsWith(groupPrefix.toUpperCase())) {
    res.status(409).json({ error: 'Patient group details do not match the selected scheme.' });
    return;
  }

  const supply = Number(rx.days_supply);
  const unitPriceCents = Number(rx.unit_price_cents);
  if (!Number.isSafeInteger(supply) || supply < 1 || supply > 180) {
    res.status(409).json({ error: 'Prescription days supply is invalid; correct the prescription before adjudication.' });
    return;
  }
  if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 1) {
    res.status(409).json({ error: 'Prescription price is invalid; correct the prescription before adjudication.' });
    return;
  }

  const priorFill = db
    .prepare(
      `SELECT days_supply, updated_at FROM prescriptions
       WHERE patient_id = ? AND inventory_id = ? AND id != ? AND status = 'dispensed'
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(String(rx.patient_id), String(rx.inventory_id), cleanPrescriptionId) as
    | { days_supply: number; updated_at: string }
    | undefined;

  let daysSinceLastFill: number | undefined;
  let priorFillDaysSupply: number | undefined;
  if (priorFill) {
    priorFillDaysSupply = Number(priorFill.days_supply);
    daysSinceLastFill = Math.max(
      0,
      Math.floor((Date.now() - new Date(priorFill.updated_at).getTime()) / 86400000)
    );
  }

  const plan = {
    id: String(planRow.id),
    payerName: String(planRow.payer_name),
    bin: planBin,
    pcn: planPcn,
    groupPrefix: String(planRow.group_prefix),
    tier1CopayCents: Number(planRow.tier1_copay_cents),
    tier2CopayCents: Number(planRow.tier2_copay_cents),
    tier3CopayCents: Number(planRow.tier3_copay_cents),
    reimbursementRate: Number(planRow.reimbursement_rate),
  };

  const tier = formularyTier;
  const daw = dawCode;
  const adjudicationInput = {
    ucPriceCents: unitPriceCents,
    daysSupply: supply,
    formularyTier: tier,
    dawCode: daw,
    deductibleRemainingCents: 0,
    overrideCode: '',
    daysSinceLastFill,
    priorFillDaysSupply,
    plan,
  };
  const initialAdjudication = adjudicateClaim(adjudicationInput);
  if (cleanOverrideCode) {
    const matchesRejection =
      (initialAdjudication.rejectionCode === '70' && cleanOverrideCode === 'SCC-02') ||
      (initialAdjudication.rejectionCode === '75' &&
        /^PA-[A-Z0-9]{4,20}$/.test(cleanOverrideCode)) ||
      (initialAdjudication.rejectionCode === '79' &&
        (cleanOverrideCode === '03' || cleanOverrideCode === '07')) ||
      (initialAdjudication.rejectionCode === '88' && cleanOverrideCode === 'M0-1B');
    if (!matchesRejection) {
      res.status(400).json({ error: 'Override code is not valid for the current claim rejection.' });
      return;
    }
  }
  const adjudication = adjudicateClaim({
    ...adjudicationInput,
    overrideCode: cleanOverrideCode,
  });

  const now = new Date().toISOString();
  const existingClaim = db
    .prepare('SELECT id, claim_number FROM insurance_claims WHERE prescription_id = ?')
    .get(cleanPrescriptionId) as { id: string; claim_number: string } | undefined;

  const claimId = existingClaim?.id || `clm_${crypto.randomUUID().slice(0, 8)}`;
  const claimNumber = existingClaim?.claim_number || `CLM-${nextSequence('clm_seq', 99019)}`;

  runTx(() => {
    if (existingClaim) {
      db.prepare(
        `UPDATE insurance_claims SET
          payer_name = ?, bin = ?, pcn = ?, group_id = ?, formulary_tier = ?, daw_code = ?, days_supply = ?,
          uc_price_cents = ?, allowed_amount_cents = ?, insurer_paid_cents = ?, deductible_applied_cents = ?,
          patient_copay_cents = ?, rejection_code = ?, rejection_message = ?, override_code = ?, override_notes = ?,
          claim_status = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        plan.payerName,
        plan.bin,
        plan.pcn,
        groupId,
        tier,
        daw,
        supply,
        unitPriceCents,
        adjudication.allowedAmountCents,
        adjudication.insurerPaidCents,
        adjudication.deductibleAppliedCents,
        adjudication.patientCopayCents,
        adjudication.rejectionCode,
        adjudication.rejectionMessage,
        cleanOverrideCode,
        cleanOverrideNotes,
        adjudication.claimStatus,
        now,
        claimId
      );
    } else {
      db.prepare(
        `INSERT INTO insurance_claims (
          id, claim_number, prescription_id, rx_number, patient_id, patient_name, medication_name,
          payer_name, bin, pcn, group_id, formulary_tier, daw_code, days_supply,
          uc_price_cents, allowed_amount_cents, insurer_paid_cents, deductible_applied_cents,
          patient_copay_cents, rejection_code, rejection_message, override_code, override_notes,
          claim_status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        claimId,
        claimNumber,
        cleanPrescriptionId,
        String(rx.rx_number),
        String(rx.patient_id),
        String(rx.patient_name),
        String(rx.medication_name),
        plan.payerName,
        plan.bin,
        plan.pcn,
        groupId,
        tier,
        daw,
        supply,
        unitPriceCents,
        adjudication.allowedAmountCents,
        adjudication.insurerPaidCents,
        adjudication.deductibleAppliedCents,
        adjudication.patientCopayCents,
        adjudication.rejectionCode,
        adjudication.rejectionMessage,
        cleanOverrideCode,
        cleanOverrideNotes,
        adjudication.claimStatus,
        now
      );
    }

    const nextRxStatus: PrescriptionStatus =
      adjudication.claimStatus === 'rejected'
        ? 'insurance_hold'
        : rx.status === 'dispensed'
          ? 'dispensed'
          : 'ready';

    db.prepare('UPDATE prescriptions SET status = ?, updated_at = ? WHERE id = ?').run(
      nextRxStatus,
      now,
      cleanPrescriptionId
    );

    writeAuditLog(
      req.user!.uid,
      req.user!.displayName,
      req.user!.role,
      adjudication.claimStatus === 'rejected' ? 'CLAIM_REJECTED' : 'CLAIM_ADJUDICATED',
      'insurance_claims',
      claimId,
      `${claimNumber} (${plan.payerName}): ${adjudication.claimStatus.toUpperCase()} · Insurer GH₵${(
        adjudication.insurerPaidCents / 100
      ).toFixed(2)} / Copay GH₵${(adjudication.patientCopayCents / 100).toFixed(2)}${
        adjudication.rejectionCode !== 'none' ? ` [NCPDP ${adjudication.rejectionCode}]` : ''
      } · Tier ${tier} · DAW ${daw} · ${supply} days · Manual override: ${
        cleanOverrideCode ? 'yes' : 'no'
      }`
    );
  });

  broadcastTopics(['claims', 'prescriptions', 'analytics', 'audit']);
  res.json({ ok: true, claimId, claimNumber, adjudication });
});

app.post('/api/staff/replenishments/:id/receive', requireAuth, requireRole('pharmacist', 'owner'), (req: AuthedRequest, res) => {
  const po = db
    .prepare('SELECT * FROM replenishment_orders WHERE id = ?')
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!po) {
    res.status(404).json({ error: 'Replenishment order not found.' });
    return;
  }
  if (po.status === 'received') {
    res.status(400).json({ error: 'Order already received into inventory.' });
    return;
  }

  let qtyToAdd: number;
  try {
    qtyToAdd = validateConfirmedQuantity(po.confirmed_qty ?? po.requested_qty, po.requested_qty);
  } catch (err) {
    res.status(409).json({
      error: err instanceof Error ? err.message : 'Purchase order quantity is invalid.',
    });
    return;
  }
  const now = new Date().toISOString();

  runTx(() => {
    db.prepare(
      `UPDATE inventory SET stock_quantity = stock_quantity + ?, lot_number = COALESCE(?, lot_number), expiry_date = COALESCE(?, expiry_date) WHERE id = ?`
    ).run(
      qtyToAdd,
      po.batch_number ? String(po.batch_number) : null,
      po.batch_expiry ? String(po.batch_expiry) : null,
      String(po.inventory_id)
    );

    db.prepare(`UPDATE replenishment_orders SET status = 'received', updated_at = ? WHERE id = ?`).run(
      now,
      req.params.id
    );

    writeAuditLog(
      req.user!.uid,
      req.user!.displayName,
      req.user!.role,
      'REPLENISHMENT_RECEIVED',
      'replenishment_orders',
      req.params.id,
      `Received ${qtyToAdd} units of ${String(po.medication_name)} (${String(po.po_number)}).`
    );
  });

  broadcastTopics(['inventory', 'replenishments', 'analytics', 'audit']);
  res.json({ ok: true });
});

// ================= SUPPLIER PORTAL =================

app.get('/api/supplier/orders', requireAuth, requireRole('supplier', 'owner'), (req: AuthedRequest, res) => {
  const rows =
    req.user!.role === 'owner'
      ? (db.prepare('SELECT * FROM replenishment_orders ORDER BY created_at DESC').all() as Record<
          string,
          unknown
        >[])
      : (db
          .prepare('SELECT * FROM replenishment_orders WHERE supplier_id = ? ORDER BY created_at DESC')
          .all(req.user!.uid) as Record<string, unknown>[]);

  res.json({
    orders: rows.map((po) => ({
      id: String(po.id),
      poNumber: String(po.po_number),
      inventoryId: String(po.inventory_id),
      medicationName: String(po.medication_name),
      ndcCode: String(po.ndc_code),
      supplierId: String(po.supplier_id),
      supplierName: String(po.supplier_name),
      requestedQty: Number(po.requested_qty),
      confirmedQty: po.confirmed_qty !== null ? Number(po.confirmed_qty) : null,
      batchNumber: po.batch_number ? String(po.batch_number) : null,
      batchExpiry: po.batch_expiry ? String(po.batch_expiry) : null,
      scheduledDeliveryDate: po.scheduled_delivery_date ? String(po.scheduled_delivery_date) : null,
      deliveryWindow: po.delivery_window ? String(po.delivery_window) : null,
      status: po.status as ReplenishmentStatus,
      autoTriggered: Number(po.auto_triggered) === 1,
      createdAt: String(po.created_at),
      updatedAt: String(po.updated_at),
    })),
  });
});

app.patch('/api/supplier/orders/:id', requireAuth, requireRole('supplier', 'owner'), (req: AuthedRequest, res) => {
  const { confirmedQty, batchNumber, batchExpiry, scheduledDeliveryDate, deliveryWindow, status } =
    req.body as {
      confirmedQty?: number;
      batchNumber?: string;
      batchExpiry?: string;
      scheduledDeliveryDate?: string;
      deliveryWindow?: string;
      status?: 'confirmed_scheduled' | 'in_transit';
    };

  const po = db
    .prepare('SELECT * FROM replenishment_orders WHERE id = ?')
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!po) {
    res.status(404).json({ error: 'Purchase order not found.' });
    return;
  }
  if (req.user!.role === 'supplier' && String(po.supplier_id) !== req.user!.uid) {
    res.status(403).json({ error: 'Cannot modify another supplier order.' });
    return;
  }
  if (po.status === 'received') {
    res.status(400).json({ error: 'Order already received.' });
    return;
  }

  let safeConfirmedQty: number;
  try {
    safeConfirmedQty = validateConfirmedQuantity(
      confirmedQty === undefined ? (po.confirmed_qty ?? po.requested_qty) : confirmedQty,
      po.requested_qty
    );
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Confirmed quantity is invalid.',
    });
    return;
  }

  const nextStatus = status === 'in_transit' ? 'in_transit' : 'confirmed_scheduled';
  const now = new Date().toISOString();

  runTx(() => {
    db.prepare(
      `UPDATE replenishment_orders SET confirmed_qty = ?, batch_number = ?, batch_expiry = ?, scheduled_delivery_date = ?, delivery_window = ?, status = ?, updated_at = ? WHERE id = ?`
    ).run(
      safeConfirmedQty,
      (batchNumber || String(po.batch_number || `LOT-SUP-${nextSequence('lot_seq', 6000)}`)).trim(),
      (batchExpiry || String(po.batch_expiry || '2028-12-31')).trim(),
      (scheduledDeliveryDate || String(po.scheduled_delivery_date || new Date(Date.now() + 86400000).toISOString().slice(0, 10))).trim(),
      (deliveryWindow || String(po.delivery_window || '09:00 - 12:00')).trim(),
      nextStatus,
      now,
      req.params.id
    );

    writeAuditLog(
      req.user!.uid,
      req.user!.displayName,
      req.user!.role,
      `SUPPLIER_${nextStatus.toUpperCase()}`,
      'replenishment_orders',
      req.params.id,
      `${String(po.po_number)} (${String(po.medication_name)}) marked ${nextStatus} for ${scheduledDeliveryDate || 'scheduled delivery'}.`
    );
  });

  broadcastTopics(['replenishments', 'audit']);
  res.json({ ok: true, status: nextStatus });
});

// ================= CONSULTATION CHAT (HUMAN-TO-HUMAN) =================

app.get('/api/consultations', requireAuth, requireRole('patient', 'pharmacist', 'owner'), (req: AuthedRequest, res) => {
  const threads =
    req.user!.role === 'patient'
      ? (db
          .prepare('SELECT * FROM consultations WHERE patient_id = ? ORDER BY last_message_at DESC')
          .all(req.user!.uid) as Record<string, unknown>[])
      : (db.prepare('SELECT * FROM consultations ORDER BY last_message_at DESC').all() as Record<
          string,
          unknown
        >[]);

  const threadList = threads.map((t) => ({
    id: String(t.id),
    patientId: String(t.patient_id),
    patientName: String(t.patient_name),
    subject: String(t.subject),
    status: t.status as 'open' | 'resolved',
    lastMessageAt: String(t.last_message_at),
    unreadCount: Number(t.unread_count),
  }));

  const messagesByThread: Record<string, unknown[]> = {};
  for (const t of threadList) {
    const msgs = db
      .prepare('SELECT * FROM consultation_messages WHERE thread_id = ? ORDER BY created_at ASC')
      .all(t.id) as Record<string, unknown>[];
    messagesByThread[t.id] = msgs.map((m) => ({
      id: String(m.id),
      threadId: String(m.thread_id),
      senderId: String(m.sender_id),
      senderName: String(m.sender_name),
      senderRole: m.sender_role as UserRole,
      body: String(m.body),
      createdAt: String(m.created_at),
    }));
  }

  res.json({ threads: threadList, messagesByThread });
});

app.post('/api/consultations', requireAuth, requireRole('patient'), (req: AuthedRequest, res) => {
  const { subject, initialMessage } = req.body as { subject?: string; initialMessage?: string };
  if (!subject || !initialMessage) {
    res.status(400).json({ error: 'Subject and message are required.' });
    return;
  }

  const threadId = `con_${crypto.randomUUID().slice(0, 8)}`;
  const msgId = `msg_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  runTx(() => {
    db.prepare(
      `INSERT INTO consultations (id, patient_id, patient_name, subject, status, last_message_at, unread_count)
       VALUES (?, ?, ?, ?, 'open', ?, 1)`
    ).run(threadId, req.user!.uid, req.user!.displayName, subject.trim(), now);

    db.prepare(
      `INSERT INTO consultation_messages (id, thread_id, sender_id, sender_name, sender_role, body, created_at)
       VALUES (?, ?, ?, ?, 'patient', ?, ?)`
    ).run(msgId, threadId, req.user!.uid, req.user!.displayName, initialMessage.trim(), now);
  });

  broadcastTopics(['consultations']);
  res.status(201).json({ ok: true, threadId });
});

app.post(
  '/api/consultations/:threadId/messages',
  requireAuth,
  requireRole('patient', 'pharmacist', 'owner'),
  (req: AuthedRequest, res) => {
    const { body } = req.body as { body?: string };
    if (!body || !body.trim()) {
      res.status(400).json({ error: 'Message text cannot be empty.' });
      return;
    }

    const thread = db
      .prepare('SELECT * FROM consultations WHERE id = ?')
      .get(req.params.threadId) as Record<string, unknown> | undefined;
    if (!thread) {
      res.status(404).json({ error: 'Consultation thread not found.' });
      return;
    }
    if (req.user!.role === 'patient' && String(thread.patient_id) !== req.user!.uid) {
      res.status(403).json({ error: 'Access denied to another patient consultation.' });
      return;
    }

    const msgId = `msg_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    runTx(() => {
      db.prepare(
        `INSERT INTO consultation_messages (id, thread_id, sender_id, sender_name, sender_role, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        msgId,
        req.params.threadId,
        req.user!.uid,
        req.user!.displayName,
        req.user!.role,
        body.trim(),
        now
      );

      db.prepare(
        `UPDATE consultations SET last_message_at = ?, unread_count = ? WHERE id = ?`
      ).run(now, req.user!.role === 'patient' ? Number(thread.unread_count) + 1 : 0, req.params.threadId);
    });

    broadcastTopics(['consultations']);
    res.status(201).json({ ok: true, msgId });
  }
);

app.patch(
  '/api/consultations/:threadId/status',
  requireAuth,
  requireRole('patient', 'pharmacist', 'owner'),
  (req: AuthedRequest, res) => {
    const { status } = req.body as { status?: 'open' | 'resolved' };
    if (status !== 'open' && status !== 'resolved') {
      res.status(400).json({ error: 'Invalid thread status.' });
      return;
    }
    const thread = db
      .prepare('SELECT * FROM consultations WHERE id = ?')
      .get(req.params.threadId) as Record<string, unknown> | undefined;
    if (!thread) {
      res.status(404).json({ error: 'Consultation thread not found.' });
      return;
    }
    if (req.user!.role === 'patient' && String(thread.patient_id) !== req.user!.uid) {
      res.status(403).json({ error: 'Access denied.' });
      return;
    }
    db.prepare('UPDATE consultations SET status = ? WHERE id = ?').run(status, req.params.threadId);
    broadcastTopics(['consultations']);
    res.json({ ok: true, status });
  }
);

// ================= OWNER EXECUTIVE ANALYTICS & GOVERNANCE =================

app.get('/api/owner/governance', requireAuth, requireRole('owner'), (_req, res) => {
  const userRows = db
    .prepare('SELECT id, email, display_name, role, consent_accepted_at, created_at FROM users ORDER BY role, display_name')
    .all() as Record<string, unknown>[];
  const planRows = db
    .prepare('SELECT * FROM insurance_plans ORDER BY payer_name')
    .all() as Record<string, unknown>[];

  res.json({
    users: userRows.map((u) => ({
      id: String(u.id),
      email: String(u.email),
      displayName: String(u.display_name),
      role: u.role as UserRole,
      consentAcceptedAt: u.consent_accepted_at ? String(u.consent_accepted_at) : null,
      createdAt: String(u.created_at),
    })),
    insurancePlans: planRows.map((p) => ({
      id: String(p.id),
      payerName: String(p.payer_name),
      bin: String(p.bin),
      pcn: String(p.pcn),
      groupPrefix: String(p.group_prefix),
      tier1CopayCents: Number(p.tier1_copay_cents),
      tier2CopayCents: Number(p.tier2_copay_cents),
      tier3CopayCents: Number(p.tier3_copay_cents),
      reimbursementRate: Number(p.reimbursement_rate),
    })),
  });
});

app.post('/api/owner/users', requireAuth, requireRole('owner'), (req: AuthedRequest, res) => {
  const { email, password, displayName, role } = req.body as {
    email?: string;
    password?: string;
    displayName?: string;
    role?: UserRole;
  };
  if (!email || !password || password.length < 8 || !displayName || !role) {
    res.status(400).json({ error: 'Email, 8+ char password, name, and role are required.' });
    return;
  }
  if (!['patient', 'pharmacist', 'supplier', 'owner'].includes(role)) {
    res.status(400).json({ error: 'Invalid role.' });
    return;
  }
  const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email.trim());
  if (existing) {
    res.status(409).json({ error: 'Email already registered.' });
    return;
  }
  const id = `usr_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  runTx(() => {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, role, consent_accepted_at, marketing_opt_in, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(id, email.trim().toLowerCase(), hashPassword(password), displayName.trim(), role, now, now);

    writeAuditLog(
      req.user!.uid,
      req.user!.displayName,
      'owner',
      'STAFF_ACCOUNT_CREATED',
      'users',
      id,
      `Provisioned ${role} account for ${displayName.trim()} (${email.trim().toLowerCase()}).`
    );
  });
  broadcastTopics(['analytics', 'audit']);
  res.status(201).json({ ok: true, id });
});

app.patch('/api/owner/users/:id/role', requireAuth, requireRole('owner'), (req: AuthedRequest, res) => {
  const { role } = req.body as { role?: UserRole };
  if (!role || !['patient', 'pharmacist', 'supplier', 'owner'].includes(role)) {
    res.status(400).json({ error: 'Invalid role.' });
    return;
  }
  if (req.params.id === req.user!.uid && role !== 'owner') {
    res.status(400).json({ error: 'Owner cannot demote their own active account.' });
    return;
  }
  const target = db
    .prepare('SELECT display_name FROM users WHERE id = ?')
    .get(req.params.id) as { display_name: string } | undefined;
  if (!target) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  writeAuditLog(
    req.user!.uid,
    req.user!.displayName,
    'owner',
    'RBAC_ROLE_CHANGED',
    'users',
    req.params.id,
    `Changed role for ${target.display_name} to ${role}.`
  );
  broadcastTopics(['analytics', 'audit']);
  res.json({ ok: true });
});

app.patch('/api/owner/insurance-plans/:id', requireAuth, requireRole('owner'), (req: AuthedRequest, res) => {
  const { tier1CopayCents, tier2CopayCents, tier3CopayCents, reimbursementRate } = req.body as {
    tier1CopayCents?: number;
    tier2CopayCents?: number;
    tier3CopayCents?: number;
    reimbursementRate?: number;
  };
  const existing = db
    .prepare('SELECT * FROM insurance_plans WHERE id = ?')
    .get(req.params.id) as Record<string, unknown> | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Insurance plan not found.' });
    return;
  }
  db.prepare(
    `UPDATE insurance_plans SET tier1_copay_cents = ?, tier2_copay_cents = ?, tier3_copay_cents = ?, reimbursement_rate = ? WHERE id = ?`
  ).run(
    typeof tier1CopayCents === 'number' ? Math.max(0, tier1CopayCents) : Number(existing.tier1_copay_cents),
    typeof tier2CopayCents === 'number' ? Math.max(0, tier2CopayCents) : Number(existing.tier2_copay_cents),
    typeof tier3CopayCents === 'number' ? Math.max(0, tier3CopayCents) : Number(existing.tier3_copay_cents),
    typeof reimbursementRate === 'number'
      ? Math.min(1, Math.max(0.5, reimbursementRate))
      : Number(existing.reimbursement_rate),
    req.params.id
  );
  writeAuditLog(
    req.user!.uid,
    req.user!.displayName,
    'owner',
    'PAYER_CONTRACT_UPDATED',
    'insurance_plans',
    req.params.id,
    `Updated contracted rates for ${String(existing.payer_name)}.`
  );
  broadcastTopics(['claims', 'audit']);
  res.json({ ok: true });
});

app.get('/api/owner/analytics', requireAuth, requireRole('owner'), (_req, res) => {
  const claims = db.prepare('SELECT * FROM insurance_claims').all() as Record<string, unknown>[];
  const rxRows = db.prepare('SELECT * FROM prescriptions').all() as Record<string, unknown>[];
  const otcRows = db.prepare('SELECT * FROM otc_orders').all() as Record<string, unknown>[];
  const posServiceRows = db
    .prepare('SELECT service_total_cents, created_at FROM pos_transactions WHERE service_total_cents > 0')
    .all() as Record<string, unknown>[];
  const invRows = db.prepare('SELECT * FROM inventory').all() as Record<string, unknown>[];
  const poRows = db.prepare('SELECT * FROM replenishment_orders').all() as Record<string, unknown>[];
  const auditRows = db
    .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 40')
    .all() as Record<string, unknown>[];

  const totalInsurerPayoutCents = claims
    .filter((c) => c.claim_status === 'adjudicated' || c.claim_status === 'paid')
    .reduce((acc, c) => acc + Number(c.insurer_paid_cents), 0);

  const totalPatientCopayCents = claims
    .filter((c) => c.claim_status === 'adjudicated' || c.claim_status === 'paid')
    .reduce((acc, c) => acc + Number(c.patient_copay_cents), 0);

  const totalRxRevenueCents = totalInsurerPayoutCents + totalPatientCopayCents;
  const totalOtcRevenueCents =
    otcRows.reduce((acc, o) => acc + Number(o.total_cents), 0) +
    posServiceRows.reduce((acc, s) => acc + Number(s.service_total_cents), 0);

  const payerMap = new Map<
    string,
    { payerName: string; claimCount: number; insurerPaidCents: number; copayCents: number }
  >();
  for (const c of claims) {
    const payer = String(c.payer_name);
    const cur = payerMap.get(payer) || {
      payerName: payer,
      claimCount: 0,
      insurerPaidCents: 0,
      copayCents: 0,
    };
    cur.claimCount += 1;
    if (c.claim_status === 'adjudicated' || c.claim_status === 'paid') {
      cur.insurerPaidCents += Number(c.insurer_paid_cents);
      cur.copayCents += Number(c.patient_copay_cents);
    }
    payerMap.set(payer, cur);
  }

  // Real 6-day trend series aggregated strictly from persisted SQLite records
  const today = new Date();
  const dailyTrends: Array<{
    date: string;
    rxCount: number;
    rxRevenueCents: number;
    otcRevenueCents: number;
  }> = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const dayIso = d.toISOString().slice(0, 10);
    const label = dayIso.slice(5, 10);

    const dayRxCount = rxRows.filter(
      (r) => String(r.updated_at).slice(0, 10) === dayIso
    ).length;

    const dayRxRevenueCents = claims
      .filter(
        (c) =>
          (c.claim_status === 'adjudicated' || c.claim_status === 'paid') &&
          String(c.updated_at).slice(0, 10) === dayIso
      )
      .reduce(
        (acc, c) => acc + Number(c.insurer_paid_cents) + Number(c.patient_copay_cents),
        0
      );

    const dayOtcRevenueCents =
      otcRows
        .filter((o) => String(o.created_at).slice(0, 10) === dayIso)
        .reduce((acc, o) => acc + Number(o.total_cents), 0) +
      posServiceRows
        .filter((s) => String(s.created_at).slice(0, 10) === dayIso)
        .reduce((acc, s) => acc + Number(s.service_total_cents), 0);

    dailyTrends.push({
      date: label,
      rxCount: dayRxCount,
      rxRevenueCents: dayRxRevenueCents,
      otcRevenueCents: dayOtcRevenueCents,
    });
  }

  const dispensedByInv = new Map<string, number>();
  for (const r of rxRows) {
    const invId = String(r.inventory_id);
    dispensedByInv.set(invId, (dispensedByInv.get(invId) || 0) + (r.status === 'dispensed' ? 1 : 0));
  }

  const topMedications = invRows
    .map((i) => ({
      name: String(i.name),
      category: i.category as InventoryItem['category'],
      stockQuantity: Number(i.stock_quantity),
      reorderThreshold: Number(i.reorder_threshold),
      dispensedUnits: dispensedByInv.get(String(i.id)) || 0,
    }))
    .sort((a, b) => a.stockQuantity - b.stockQuantity)
    .slice(0, 6);

  res.json({
    totalRxRevenueCents,
    totalInsurerPayoutCents,
    totalPatientCopayCents,
    totalOtcRevenueCents,
    totalPrescriptions: rxRows.length,
    dispensedCount: rxRows.filter((r) => r.status === 'dispensed').length,
    adjudicatedClaimsCount: claims.filter(
      (c) => c.claim_status === 'adjudicated' || c.claim_status === 'paid'
    ).length,
    rejectedClaimsCount: claims.filter((c) => c.claim_status === 'rejected').length,
    lowStockItemsCount: invRows.filter(
      (i) => Number(i.stock_quantity) <= Number(i.reorder_threshold)
    ).length,
    pendingReplenishmentsCount: poRows.filter((po) => po.status !== 'received').length,
    dailyTrends,
    payerBreakdown: Array.from(payerMap.values()),
    topMedications,
    auditLogs: auditRows.map((a) => ({
      id: String(a.id),
      actorId: String(a.actor_id),
      actorName: String(a.actor_name),
      actorRole: a.actor_role as UserRole | 'public',
      action: String(a.action),
      resourceType: String(a.resource_type),
      resourceId: String(a.resource_id),
      summary: String(a.summary),
      createdAt: String(a.created_at),
    })),
  });
});

// Mount Vite dev server or production static build
async function startServer(): Promise<void> {
  const drugImgPath = path.resolve(process.cwd(), 'public', 'drug-images');
  fs.mkdirSync(drugImgPath, { recursive: true });
  app.use('/drug-images', express.static(drugImgPath));

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: false,
        watch: null,
        ws: {
          server,
          path: '/vite-hmr',
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('/*splat', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  const portArgIdx = process.argv.indexOf('--port');
  const cliPort = portArgIdx !== -1 ? Number(process.argv[portArgIdx + 1]) : NaN;
  const envPort = Number(process.env.PORT);
  const port =
    Number.isFinite(cliPort) && cliPort > 0
      ? cliPort
      : process.env.NODE_ENV !== 'production' && (!envPort || envPort === 8080)
        ? 3000
        : envPort || 3000;

  server.listen(port, '0.0.0.0', () => {
    console.log(`NETANYA PHARMACY & RETAIL SHOP server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
