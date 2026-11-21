export type UserRole = 'patient' | 'pharmacist' | 'supplier' | 'owner';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  consentAcceptedAt: string | null;
  marketingOptIn: boolean;
}

export interface PatientPHI {
  dob: string;
  phone: string;
  address: string;
  allergies: string[];
  insuranceProvider: string;
  bin: string;
  pcn: string;
  groupNumber: string;
  memberId: string;
}

export const INVENTORY_CATEGORIES = [
  'Pain & Fever',
  'Malaria & Infections',
  'Chronic & Heart',
  'Cough, Cold & Allergy',
  'Digestive & Stomach',
  'Vitamins & Wellness',
  'Devices & First Aid',
] as const;

export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number];

export interface InventoryItem {
  id: string;
  ndcCode: string;
  name: string;
  category: InventoryCategory;
  description: string;
  imageUrl: string | null;
  manufacturerName: string;
  activeIngredient: string;
  dosageForm: string;
  usageDirections: string;
  warnings: string;
  storageInfo: string;
  officialSourceUrl: string | null;
  unitPriceCents: number;
  costPriceCents: number;
  stockQuantity: number;
  reorderThreshold: number;
  reorderQuantity: number;
  lotNumber: string;
  expiryDate: string;
  supplierId: string;
  supplierName: string;
  autoReorderEnabled: boolean;
  requiresPrescription: boolean;
}

export interface OfficialDrugLookupResult {
  ndcCode: string;
  name: string;
  manufacturerName: string;
  activeIngredient: string;
  dosageForm: string;
  description: string;
  usageDirections: string;
  warnings: string;
  storageInfo: string;
  imageUrl: string | null;
  officialSourceUrl: string;
  requiresPrescription: boolean;
}

export interface PharmacyService {
  id: string;
  name: string;
  category: string;
  turnaroundMinutes: number;
  priceCents: number;
  notes: string;
  active: boolean;
}

export interface ServiceLog {
  id: string;
  serviceId: string;
  serviceName: string;
  patientName: string;
  resultValue: string;
  notes: string;
  priceCents: number;
  recordedBy: string;
  createdAt: string;
}

export type PrescriptionStatus =
  | 'submitted'
  | 'verifying'
  | 'insurance_hold'
  | 'ready'
  | 'dispensed';

export interface Prescription {
  id: string;
  rxNumber: string;
  patientId: string;
  patientName: string;
  inventoryId: string;
  medicationName: string;
  ndcCode: string;
  prescriberName: string;
  dosageInstructions: string;
  quantity: number;
  daysSupply: number;
  refillsRemaining: number;
  nextRefillEligibleAt: string;
  status: PrescriptionStatus;
  unitPriceCents: number;
  updatedAt: string;
}

export interface CarePlan {
  id: string;
  patientId: string;
  patientName: string;
  pharmacistName: string;
  conditionFocus: string;
  clinicalGoals: string;
  interactionWarnings: string;
  adherenceNotes: string;
  followUpDate: string;
  updatedAt: string;
}

export type NcpdpRejectionCode = 'none' | '70' | '75' | '79' | '88';

export type ClaimStatus = 'draft' | 'rejected' | 'adjudicated' | 'paid';

export interface InsurancePlan {
  id: string;
  payerName: string;
  bin: string;
  pcn: string;
  groupPrefix: string;
  tier1CopayCents: number;
  tier2CopayCents: number;
  tier3CopayCents: number;
  reimbursementRate: number;
}

export interface InsuranceClaim {
  id: string;
  claimNumber: string;
  prescriptionId: string;
  rxNumber: string;
  patientId: string;
  patientName: string;
  medicationName: string;
  payerName: string;
  bin: string;
  pcn: string;
  groupId: string;
  formularyTier: 1 | 2 | 3;
  dawCode: '0' | '1' | '2';
  daysSupply: number;
  ucPriceCents: number;
  allowedAmountCents: number;
  insurerPaidCents: number;
  deductibleAppliedCents: number;
  patientCopayCents: number;
  rejectionCode: NcpdpRejectionCode;
  rejectionMessage: string;
  overrideCode: string;
  overrideNotes: string;
  claimStatus: ClaimStatus;
  updatedAt: string;
}

export type ReplenishmentStatus =
  | 'awaiting_supplier'
  | 'confirmed_scheduled'
  | 'in_transit'
  | 'received';

export interface ReplenishmentOrder {
  id: string;
  poNumber: string;
  inventoryId: string;
  medicationName: string;
  ndcCode: string;
  supplierId: string;
  supplierName: string;
  requestedQty: number;
  confirmedQty: number | null;
  batchNumber: string | null;
  batchExpiry: string | null;
  scheduledDeliveryDate: string | null;
  deliveryWindow: string | null;
  status: ReplenishmentStatus;
  autoTriggered: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MedicationReminder {
  id: string;
  patientId: string;
  medicationName: string;
  dosageLabel: string;
  timeOfDay: string;
  frequency: string;
  pushEnabled: boolean;
  lastTakenDate: string | null;
  adherenceStreak: number;
}

export interface ConsultationThread {
  id: string;
  patientId: string;
  patientName: string;
  subject: string;
  status: 'open' | 'resolved';
  lastMessageAt: string;
  unreadCount: number;
}

export interface ConsultationMessage {
  id: string;
  threadId: string;
  senderId: string;
  senderName: string;
  senderRole: UserRole;
  body: string;
  createdAt: string;
}

export interface OtcOrderItem {
  inventoryId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
}

export interface OtcOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  fulfillmentType: 'pickup' | 'delivery';
  shippingAddress: string;
  items: OtcOrderItem[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  status: 'confirmed' | 'ready_for_pickup' | 'dispatched';
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  actorId: string;
  actorName: string;
  actorRole: UserRole | 'public';
  action: string;
  resourceType: string;
  resourceId: string;
  summary: string;
  createdAt: string;
}

export interface OwnerAnalytics {
  totalRxRevenueCents: number;
  totalInsurerPayoutCents: number;
  totalPatientCopayCents: number;
  totalOtcRevenueCents: number;
  totalPrescriptions: number;
  dispensedCount: number;
  adjudicatedClaimsCount: number;
  rejectedClaimsCount: number;
  lowStockItemsCount: number;
  pendingReplenishmentsCount: number;
  dailyTrends: Array<{
    date: string;
    rxCount: number;
    rxRevenueCents: number;
    otcRevenueCents: number;
  }>;
  payerBreakdown: Array<{
    payerName: string;
    claimCount: number;
    insurerPaidCents: number;
    copayCents: number;
  }>;
  topMedications: Array<{
    name: string;
    category: InventoryCategory;
    stockQuantity: number;
    reorderThreshold: number;
    dispensedUnits: number;
  }>;
  auditLogs: AuditLogEntry[];
}

export interface PosReceipt {
  id?: string;
  receiptNumber: string;
  customerName: string;
  cashierName: string;
  paymentMethod: 'cash' | 'card' | 'mobile_pay';
  discountPercent: number;
  otcLines: Array<{ inventoryId: string; name: string; quantity: number; unitPriceCents: number }>;
  rxLines: Array<{
    prescriptionId: string;
    rxNumber: string;
    patientName: string;
    medicationName: string;
    copayCents: number;
  }>;
  serviceLines?: Array<{ serviceId: string; name: string; quantity: number; priceCents: number }>;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  rxCopayTotalCents: number;
  serviceTotalCents?: number;
  grandTotalCents: number;
  tenderedCents: number;
  changeDueCents: number;
  poTriggered: boolean;
  createdAt: string;
}

export type CashDrawerTrigger =
  | 'cash_sale'
  | 'manual_no_sale'
  | 'cash_drop'
  | 'shift_count'
  | 'refund';

export interface CashDrawerEvent {
  id: string;
  actorId: string;
  actorName: string;
  actorRole: UserRole;
  triggerType: CashDrawerTrigger;
  reason: string;
  receiptNumber: string | null;
  hardwareTransport: string;
  authorizedAt: string;
}

