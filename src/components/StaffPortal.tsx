import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Boxes,
  Calculator,
  CheckCircle2,
  ClipboardList,
  Edit3,
  ExternalLink,
  Info,
  Loader2,
  LogOut,
  MessageSquare,
  PackageCheck,
  PackagePlus,
  Pill,
  Plus,
  Receipt,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  Stethoscope,
  X,
} from 'lucide-react';
import {
  INVENTORY_CATEGORIES,
  type AuthUser,
  type CarePlan,
  type CashDrawerEvent,
  type InsuranceClaim,
  type InsurancePlan,
  type InventoryCategory,
  type InventoryItem,
  type OfficialDrugLookupResult,
  type OtcOrder,
  type PatientPHI,
  type PharmacyService,
  type PosReceipt,
  type Prescription,
  type PrescriptionStatus,
  type ReplenishmentOrder,
  type ServiceLog,
} from '../types.ts';
import { apiFetch, formatMoney, useRealtimeTopics } from '../utils/api.ts';
import { ConsultationChat } from './ConsultationChat.tsx';
import { NetanyaLogo } from './NetanyaLogo.tsx';
import { POSTerminal } from './POSTerminal.tsx';
import { PWAInstallButton } from './PWAControls.tsx';

interface StaffPortalProps {
  user: AuthUser;
  token: string;
  onGoToStorefront: () => void;
  onLogout: () => void;
  embedded?: boolean;
}

type StaffTab = 'pos' | 'rx' | 'services' | 'claims' | 'inventory' | 'consults';
type RxSubTab = 'queue' | 'care_plans';
type InventorySubTab = 'stock' | 'reorders' | 'online_orders';
type ActiveDrawer = null | 'new_rx' | 'patient_phi' | 'new_care_plan' | 'new_sku' | 'new_service';

interface StaffPatientRecord {
  id: string;
  displayName: string;
  email: string;
  phi: PatientPHI | null;
}

const RX_STATUS_LABELS: Record<PrescriptionStatus, string> = {
  submitted: 'New Request',
  verifying: 'To Check',
  insurance_hold: 'Insurance Hold',
  ready: 'Ready for Pickup',
  dispensed: 'Handed Over',
};

const PO_STATUS_LABELS: Record<string, string> = {
  awaiting_supplier: 'Waiting for Supplier',
  confirmed_scheduled: 'Confirmed',
  in_transit: 'On the Way',
  received: 'Received',
};

export const StaffPortal: React.FC<StaffPortalProps> = ({
  user,
  token,
  onGoToStorefront,
  onLogout,
  embedded = false,
}) => {
  const [activeTab, setActiveTab] = useState<StaffTab>('rx');
  const [rxSubTab, setRxSubTab] = useState<RxSubTab>('queue');
  const [invSubTab, setInvSubTab] = useState<InventorySubTab>('stock');
  const [drawer, setDrawer] = useState<ActiveDrawer>(null);
  const [posPreselectRxId, setPosPreselectRxId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [carePlans, setCarePlans] = useState<CarePlan[]>([]);
  const [claims, setClaims] = useState<InsuranceClaim[]>([]);
  const [insurancePlans, setInsurancePlans] = useState<InsurancePlan[]>([]);
  const [replenishments, setReplenishments] = useState<ReplenishmentOrder[]>([]);
  const [otcOrders, setOtcOrders] = useState<OtcOrder[]>([]);
  const [posReceipts, setPosReceipts] = useState<PosReceipt[]>([]);
  const [services, setServices] = useState<PharmacyService[]>([]);
  const [serviceLogs, setServiceLogs] = useState<ServiceLog[]>([]);
  const [drawerEvents, setDrawerEvents] = useState<CashDrawerEvent[]>([]);
  const [patients, setPatients] = useState<StaffPatientRecord[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  // Rx Queue Filters & New Rx Form
  const [rxStatusFilter, setRxStatusFilter] = useState<'ALL' | PrescriptionStatus>('ALL');
  const [rxSearch, setRxSearch] = useState('');
  const [newRxPatientId, setNewRxPatientId] = useState('usr_patient_maya');
  const [newRxInventoryId, setNewRxInventoryId] = useState('');
  const [newRxPrescriber, setNewRxPrescriber] = useState('');
  const [newRxDosage, setNewRxDosage] = useState('');
  const [newRxQty, setNewRxQty] = useState(30);
  const [newRxDaysSupply, setNewRxDaysSupply] = useState(30);
  const [newRxRefills, setNewRxRefills] = useState(3);
  const [newRxBusy, setNewRxBusy] = useState(false);

  // Patient Allergies & Insurance Drawer
  const [phiPatientId, setPhiPatientId] = useState('usr_patient_maya');
  const [phiAllergiesText, setPhiAllergiesText] = useState('');
  const [phiProvider, setPhiProvider] = useState('');
  const [phiBin, setPhiBin] = useState('');
  const [phiPcn, setPhiPcn] = useState('');
  const [phiGroup, setPhiGroup] = useState('');
  const [phiMemberId, setPhiMemberId] = useState('');
  const [phiSaving, setPhiSaving] = useState(false);

  // Care Plan Create & Edit
  const [cpPatientId, setCpPatientId] = useState('usr_patient_maya');
  const [cpFocus, setCpFocus] = useState('');
  const [cpGoals, setCpGoals] = useState('');
  const [cpWarnings, setCpWarnings] = useState('');
  const [cpFollowUp, setCpFollowUp] = useState('');
  const [cpBusy, setCpBusy] = useState(false);
  const [editingCarePlanId, setEditingCarePlanId] = useState<string | null>(null);
  const [editCpGoals, setEditCpGoals] = useState('');
  const [editCpWarnings, setEditCpWarnings] = useState('');
  const [editCpAdherence, setEditCpAdherence] = useState('');
  const [editCpFollowUp, setEditCpFollowUp] = useState('');
  const [editCpBusy, setEditCpBusy] = useState(false);

  // Insurance Claim Form
  const [selectedRxId, setSelectedRxId] = useState<string>('rx_1003');
  const [selectedPlanId, setSelectedPlanId] = useState<string>('plan_bcbs');
  const [claimBin, setClaimBin] = useState('233001');
  const [claimPcn, setClaimPcn] = useState('NHISGH');
  const [claimGroup, setClaimGroup] = useState('NHIS-100');
  const [formularyTier, setFormularyTier] = useState<1 | 2 | 3>(1);
  const [dawCode, setDawCode] = useState<'0' | '1' | '2'>('0');
  const [daysSupply, setDaysSupply] = useState(30);
  const [deductibleDollars, setDeductibleDollars] = useState('0');
  const [overrideCode, setOverrideCode] = useState('');
  const [overrideNotes, setOverrideNotes] = useState('');
  const [claimBusy, setClaimBusy] = useState(false);

  // Inventory Search, Category Filter, Thresholds & New Item Drawer
  const [invSearch, setInvSearch] = useState('');
  const [invCategoryFilter, setInvCategoryFilter] = useState<'ALL' | InventoryCategory>('ALL');
  const [shortageOnly, setShortageOnly] = useState(false);
  const [skuNdc, setSkuNdc] = useState('');
  const [skuName, setSkuName] = useState('');
  const [skuCategory, setSkuCategory] = useState<InventoryCategory>('Pain & Fever');
  const [skuRequiresRx, setSkuRequiresRx] = useState(false);
  const [skuDesc, setSkuDesc] = useState('');
  const [skuUnitDollars, setSkuUnitDollars] = useState('42.00');
  const [skuCostDollars, setSkuCostDollars] = useState('18.00');
  const [skuStock, setSkuStock] = useState(25);
  const [skuThreshold, setSkuThreshold] = useState(10);
  const [skuReorderQty, setSkuReorderQty] = useState(40);
  const [skuLot, setSkuLot] = useState('');
  const [skuExpiry, setSkuExpiry] = useState('2028-12-31');
  const [skuManufacturer, setSkuManufacturer] = useState('');
  const [skuActiveIngredient, setSkuActiveIngredient] = useState('');
  const [skuDosageForm, setSkuDosageForm] = useState('');
  const [skuUsageDirections, setSkuUsageDirections] = useState('');
  const [skuWarnings, setSkuWarnings] = useState('');
  const [skuStorageInfo, setSkuStorageInfo] = useState('');
  const [skuImageUrl, setSkuImageUrl] = useState('');
  const [skuOfficialSourceUrl, setSkuOfficialSourceUrl] = useState('');
  const [lookupQuery, setLookupQuery] = useState('');
  const [lookupResults, setLookupResults] = useState<OfficialDrugLookupResult[]>([]);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [selectedInventoryInfo, setSelectedInventoryInfo] = useState<InventoryItem | null>(null);
  const [skuBusy, setSkuBusy] = useState(false);
  const [thresholdDrafts, setThresholdDrafts] = useState<
    Record<string, { stock: number; threshold: number }>
  >({});

  // Tests & Services State
  const [servicePriceDrafts, setServicePriceDrafts] = useState<Record<string, string>>({});
  const [logServiceId, setLogServiceId] = useState('srv_bp');
  const [logPatientName, setLogPatientName] = useState('');
  const [logResultValue, setLogResultValue] = useState('');
  const [logNotes, setLogNotes] = useState('');
  const [logBusy, setLogBusy] = useState(false);
  const [srvName, setSrvName] = useState('');
  const [srvCategory, setSrvCategory] = useState('Rapid Screening');
  const [srvTurnaround, setSrvTurnaround] = useState(10);
  const [srvPriceDollars, setSrvPriceDollars] = useState('25.00');
  const [srvNotes, setSrvNotes] = useState('');
  const [srvBusy, setSrvBusy] = useState(false);

  const loadWorkspace = useCallback(async () => {
    try {
      const data = await apiFetch<{
        inventory: InventoryItem[];
        prescriptions: Prescription[];
        carePlans: CarePlan[];
        claims: InsuranceClaim[];
        insurancePlans: InsurancePlan[];
        replenishments: ReplenishmentOrder[];
        otcOrders: OtcOrder[];
        posReceipts?: PosReceipt[];
        services?: PharmacyService[];
        serviceLogs?: ServiceLog[];
        drawerEvents?: CashDrawerEvent[];
        patients: StaffPatientRecord[];
      }>('/api/staff/workspace');
      setInventory(data.inventory);
      setPrescriptions(data.prescriptions);
      setCarePlans(data.carePlans);
      setClaims(data.claims);
      setInsurancePlans(data.insurancePlans);
      setReplenishments(data.replenishments);
      setOtcOrders(data.otcOrders || []);
      setPosReceipts(data.posReceipts || []);
      const loadedServices = data.services || [];
      setServices(loadedServices);
      setServiceLogs(data.serviceLogs || []);
      setDrawerEvents(data.drawerEvents || []);
      setPatients(data.patients);

      if (data.inventory.length > 0 && !newRxInventoryId) {
        const firstRxItem = data.inventory.find((i) => i.requiresPrescription) || data.inventory[0];
        setNewRxInventoryId(firstRxItem.id);
      }
      if (loadedServices.length > 0) {
        setLogServiceId((prev) =>
          loadedServices.some((s) => s.id === prev) ? prev : loadedServices[0].id
        );
        const srvDrafts: Record<string, string> = {};
        for (const s of loadedServices) {
          srvDrafts[s.id] = (s.priceCents / 100).toFixed(2);
        }
        setServicePriceDrafts(srvDrafts);
      }
      if (data.prescriptions.length > 0) {
        setSelectedRxId((prev) =>
          data.prescriptions.some((r) => r.id === prev) ? prev : data.prescriptions[0].id
        );
      }
      if (data.insurancePlans.length > 0) {
        setSelectedPlanId((prev) => {
          if (data.insurancePlans.some((p) => p.id === prev)) return prev;
          const first = data.insurancePlans[0];
          setClaimBin(first.bin);
          setClaimPcn(first.pcn);
          setClaimGroup(`${first.groupPrefix}100`);
          return first.id;
        });
      }
      if (data.patients.length > 0) {
        setCpPatientId((prev) =>
          data.patients.some((p) => p.id === prev) ? prev : data.patients[0].id
        );
        setNewRxPatientId((prev) =>
          data.patients.some((p) => p.id === prev) ? prev : data.patients[0].id
        );
        setPhiPatientId((prev) =>
          data.patients.some((p) => p.id === prev) ? prev : data.patients[0].id
        );
      }

      const drafts: Record<string, { stock: number; threshold: number }> = {};
      for (const item of data.inventory) {
        drafts[item.id] = { stock: item.stockQuantity, threshold: item.reorderThreshold };
      }
      setThresholdDrafts(drafts);
    } finally {
      setLoading(false);
    }
  }, [newRxInventoryId]);

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  useRealtimeTopics(
    ['inventory', 'services', 'prescriptions', 'claims', 'replenishments'],
    loadWorkspace,
    token
  );

  // Sync PHI editor fields when selected patient changes
  useEffect(() => {
    const p = patients.find((rec) => rec.id === phiPatientId);
    if (p?.phi) {
      setPhiAllergiesText(p.phi.allergies.join(', '));
      setPhiProvider(p.phi.insuranceProvider);
      setPhiBin(p.phi.bin);
      setPhiPcn(p.phi.pcn);
      setPhiGroup(p.phi.groupNumber);
      setPhiMemberId(p.phi.memberId);
    } else {
      setPhiAllergiesText('');
      setPhiProvider('');
      setPhiBin('');
      setPhiPcn('');
      setPhiGroup('');
      setPhiMemberId('');
    }
  }, [phiPatientId, patients]);

  const selectedRx = useMemo(
    () => prescriptions.find((r) => r.id === selectedRxId) || prescriptions[0],
    [prescriptions, selectedRxId]
  );

  const selectedPlan = useMemo(
    () => insurancePlans.find((p) => p.id === selectedPlanId) || insurancePlans[0],
    [insurancePlans, selectedPlanId]
  );

  const existingClaimForRx = useMemo(
    () => claims.find((c) => c.prescriptionId === selectedRx?.id),
    [claims, selectedRx]
  );

  // Sync claim fields when selecting an existing Rx with a claim or daysSupply
  useEffect(() => {
    if (selectedRx) {
      setDaysSupply(selectedRx.daysSupply);
    }
    if (existingClaimForRx) {
      setFormularyTier(existingClaimForRx.formularyTier);
      setDawCode(existingClaimForRx.dawCode);
      setOverrideCode(existingClaimForRx.overrideCode);
      setOverrideNotes(existingClaimForRx.overrideNotes);
    }
  }, [selectedRx?.id, existingClaimForRx]);

  const filteredPrescriptions = useMemo(() => {
    const q = rxSearch.trim().toLowerCase();
    return prescriptions.filter((rx) => {
      if (rxStatusFilter !== 'ALL' && rx.status !== rxStatusFilter) return false;
      if (!q) return true;
      return (
        rx.rxNumber.toLowerCase().includes(q) ||
        rx.patientName.toLowerCase().includes(q) ||
        rx.medicationName.toLowerCase().includes(q) ||
        rx.prescriberName.toLowerCase().includes(q)
      );
    });
  }, [prescriptions, rxStatusFilter, rxSearch]);

  const filteredInventory = useMemo(() => {
    const q = invSearch.trim().toLowerCase();
    return inventory.filter((item) => {
      if (invCategoryFilter !== 'ALL' && item.category !== invCategoryFilter) return false;
      if (shortageOnly && item.stockQuantity > item.reorderThreshold) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.ndcCode.toLowerCase().includes(q) ||
        item.lotNumber.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
      );
    });
  }, [inventory, invCategoryFilter, invSearch, shortageOnly]);

  const groupedInventory = useMemo(() => {
    const categoriesToShow =
      invCategoryFilter === 'ALL' ? INVENTORY_CATEGORIES : [invCategoryFilter];
    return categoriesToShow
      .map((cat) => ({
        category: cat,
        items: filteredInventory.filter((i) => i.category === cat),
      }))
      .filter((sec) => sec.items.length > 0);
  }, [invCategoryFilter, filteredInventory]);

  const lowStockItems = useMemo(
    () => inventory.filter((i) => i.stockQuantity <= i.reorderThreshold),
    [inventory]
  );

  const rxCounts = useMemo(() => {
    let toCheck = 0;
    let hold = 0;
    let ready = 0;
    let dispensed = 0;
    for (const rx of prescriptions) {
      if (rx.status === 'submitted' || rx.status === 'verifying') toCheck += 1;
      else if (rx.status === 'insurance_hold') hold += 1;
      else if (rx.status === 'ready') ready += 1;
      else if (rx.status === 'dispensed') dispensed += 1;
    }
    return { toCheck, hold, ready, dispensed };
  }, [prescriptions]);

  const handlePlanChange = (planId: string) => {
    setSelectedPlanId(planId);
    const plan = insurancePlans.find((p) => p.id === planId);
    if (plan) {
      setClaimBin(plan.bin);
      setClaimPcn(plan.pcn);
      setClaimGroup(`${plan.groupPrefix}100`);
    }
  };

  const handleCreatePrescription = async (e: React.FormEvent) => {
    e.preventDefault();
    setNewRxBusy(true);
    try {
      const res = await apiFetch<{ rxNumber: string }>('/api/staff/prescriptions', {
        method: 'POST',
        body: JSON.stringify({
          patientId: newRxPatientId,
          inventoryId: newRxInventoryId,
          prescriberName: newRxPrescriber,
          dosageInstructions: newRxDosage,
          quantity: newRxQty,
          daysSupply: newRxDaysSupply,
          refillsRemaining: newRxRefills,
        }),
      });
      setNewRxPrescriber('');
      setNewRxDosage('');
      setDrawer(null);
      setToast(`Added prescription ${res.rxNumber} to check queue.`);
      await loadWorkspace();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not save prescription.');
    } finally {
      setNewRxBusy(false);
    }
  };

  const handleSavePatientPhi = async (e: React.FormEvent) => {
    e.preventDefault();
    setPhiSaving(true);
    try {
      await apiFetch(`/api/staff/patients/${phiPatientId}/phi`, {
        method: 'PATCH',
        body: JSON.stringify({
          allergies: phiAllergiesText
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean),
          insuranceProvider: phiProvider,
          bin: phiBin,
          pcn: phiPcn,
          groupNumber: phiGroup,
          memberId: phiMemberId,
        }),
      });
      setDrawer(null);
      setToast('Saved patient allergies and insurance details.');
      await loadWorkspace();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not update patient details.');
    } finally {
      setPhiSaving(false);
    }
  };

  const handleRxStatusChange = async (rxId: string, status: PrescriptionStatus) => {
    try {
      await apiFetch(`/api/staff/prescriptions/${rxId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setToast(
        status === 'dispensed'
          ? 'Prescription handed over and stock updated.'
          : `Prescription marked as ${RX_STATUS_LABELS[status]}.`
      );
      await loadWorkspace();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not update prescription.');
    }
  };

  const handleCreateCarePlan = async (e: React.FormEvent) => {
    e.preventDefault();
    setCpBusy(true);
    try {
      await apiFetch('/api/staff/care-plans', {
        method: 'POST',
        body: JSON.stringify({
          patientId: cpPatientId,
          conditionFocus: cpFocus,
          clinicalGoals: cpGoals,
          interactionWarnings: cpWarnings,
          adherenceNotes: 'Added by pharmacist.',
          followUpDate: cpFollowUp || undefined,
        }),
      });
      setCpFocus('');
      setCpGoals('');
      setCpWarnings('');
      setCpFollowUp('');
      setDrawer(null);
      setToast('Care plan saved and shared with patient.');
      await loadWorkspace();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not save care plan.');
    } finally {
      setCpBusy(false);
    }
  };

  const startEditCarePlan = (cp: CarePlan) => {
    setEditingCarePlanId(cp.id);
    setEditCpGoals(cp.clinicalGoals);
    setEditCpWarnings(cp.interactionWarnings);
    setEditCpAdherence(cp.adherenceNotes);
    setEditCpFollowUp(cp.followUpDate);
  };

  const handleSaveCarePlanEdit = async (carePlanId: string) => {
    setEditCpBusy(true);
    try {
      await apiFetch(`/api/staff/care-plans/${carePlanId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          clinicalGoals: editCpGoals,
          interactionWarnings: editCpWarnings,
          adherenceNotes: editCpAdherence,
          followUpDate: editCpFollowUp,
        }),
      });
      setEditingCarePlanId(null);
      setToast('Care plan updated.');
      await loadWorkspace();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not save changes.');
    } finally {
      setEditCpBusy(false);
    }
  };

  const handleRunClaim = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRx || !selectedPlan) return;
    setClaimBusy(true);
    try {
      const res = await apiFetch<{
        claimNumber: string;
        adjudication: {
          claimStatus: string;
          rejectionCode: string;
          rejectionMessage: string;
          insurerPaidCents: number;
          patientCopayCents: number;
        };
      }>('/api/staff/claims/adjudicate', {
        method: 'POST',
        body: JSON.stringify({
          prescriptionId: selectedRx.id,
          planId: selectedPlan.id,
          bin: claimBin,
          pcn: claimPcn,
          groupId: claimGroup,
          formularyTier,
          dawCode,
          daysSupply,
          deductibleRemainingCents: Math.round((Number(deductibleDollars) || 0) * 100),
          overrideCode,
          overrideNotes,
        }),
      });
      setToast(
        res.adjudication.claimStatus === 'rejected'
          ? `Claim ${res.claimNumber} held: ${res.adjudication.rejectionMessage}`
          : `Claim ${res.claimNumber} approved: Insurance pays ${formatMoney(
              res.adjudication.insurerPaidCents
            )}, patient pays ${formatMoney(res.adjudication.patientCopayCents)}.`
      );
      await loadWorkspace();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not check insurance claim.');
    } finally {
      setClaimBusy(false);
    }
  };

  const handleSaveStockThreshold = async (item: InventoryItem) => {
    const draft = thresholdDrafts[item.id];
    if (!draft) return;
    try {
      const res = await apiFetch<{ poTriggered: boolean }>(`/api/staff/inventory/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          stockQuantity: draft.stock,
          reorderThreshold: draft.threshold,
        }),
      });
      setToast(
        res.poTriggered
          ? `${item.name} is low (${draft.stock}/${draft.threshold}). Restock order sent to supplier.`
          : `Saved stock count for ${item.name}.`
      );
      await loadWorkspace();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not update stock.');
    }
  };

  const handleToggleAutoReorder = async (item: InventoryItem) => {
    try {
      const res = await apiFetch<{ poTriggered: boolean }>(`/api/staff/inventory/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ autoReorderEnabled: !item.autoReorderEnabled }),
      });
      setToast(
        !item.autoReorderEnabled
          ? res.poTriggered
            ? `Auto-reorder turned on for ${item.name} and restock order sent.`
            : `Auto-reorder turned on for ${item.name}.`
          : `Auto-reorder paused for ${item.name}.`
      );
      await loadWorkspace();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not change reorder setting.');
    }
  };

  const handleManualReorder = async (item: InventoryItem) => {
    try {
      const res = await apiFetch<{ poNumber: string }>(`/api/staff/inventory/${item.id}/reorder`, {
        method: 'POST',
      });
      setToast(`Sent order ${res.poNumber} to ${item.supplierName} for ${item.name}.`);
      await loadWorkspace();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not send restock order.');
    }
  };

  const handleOfficialLookup = async () => {
    const q = lookupQuery.trim() || skuName.trim();
    if (!q || q.length < 2) {
      setLookupError('Enter a medicine name (at least 2 letters) to pull official info.');
      return;
    }
    setLookupBusy(true);
    setLookupError(null);
    try {
      const res = await apiFetch<{ results: OfficialDrugLookupResult[] }>(
        `/api/staff/drug-lookup?q=${encodeURIComponent(q)}`
      );
      setLookupResults(res.results || []);
      if (!res.results || res.results.length === 0) {
        setLookupError('No official manufacturer label found for that query.');
      }
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : 'Official lookup failed.');
    } finally {
      setLookupBusy(false);
    }
  };

  const applyLookupResult = (hit: OfficialDrugLookupResult) => {
    setSkuName(hit.name);
    if (hit.ndcCode && !skuNdc.trim()) setSkuNdc(hit.ndcCode);
    setSkuDesc(hit.description || '');
    setSkuManufacturer(hit.manufacturerName || '');
    setSkuActiveIngredient(hit.activeIngredient || '');
    setSkuDosageForm(hit.dosageForm || '');
    setSkuUsageDirections(hit.usageDirections || '');
    setSkuWarnings(hit.warnings || '');
    setSkuStorageInfo(hit.storageInfo || '');
    setSkuImageUrl(hit.imageUrl || '');
    setSkuOfficialSourceUrl(hit.officialSourceUrl || '');
    setSkuRequiresRx(hit.requiresPrescription);
    setLookupResults([]);
    setLookupError(null);
    setToast(`Loaded official label info from ${hit.manufacturerName}.`);
  };

  const handleCreateSku = async (e: React.FormEvent) => {
    e.preventDefault();
    setSkuBusy(true);
    try {
      const res = await apiFetch<{ poTriggered: boolean }>('/api/staff/inventory', {
        method: 'POST',
        body: JSON.stringify({
          ndcCode: skuNdc,
          name: skuName,
          category: skuCategory,
          requiresPrescription: skuRequiresRx,
          description: skuDesc,
          unitPriceCents: Math.round((Number(skuUnitDollars) || 25) * 100),
          costPriceCents: Math.round((Number(skuCostDollars) || 10) * 100),
          stockQuantity: skuStock,
          reorderThreshold: skuThreshold,
          reorderQuantity: skuReorderQty,
          lotNumber: skuLot || undefined,
          expiryDate: skuExpiry || undefined,
          manufacturerName: skuManufacturer || undefined,
          activeIngredient: skuActiveIngredient || undefined,
          dosageForm: skuDosageForm || undefined,
          usageDirections: skuUsageDirections || undefined,
          warnings: skuWarnings || undefined,
          storageInfo: skuStorageInfo || undefined,
          imageUrl: skuImageUrl || undefined,
          officialSourceUrl: skuOfficialSourceUrl || undefined,
        }),
      });
      setSkuNdc('');
      setSkuName('');
      setSkuDesc('');
      setSkuLot('');
      setSkuManufacturer('');
      setSkuActiveIngredient('');
      setSkuDosageForm('');
      setSkuUsageDirections('');
      setSkuWarnings('');
      setSkuStorageInfo('');
      setSkuImageUrl('');
      setSkuOfficialSourceUrl('');
      setLookupQuery('');
      setLookupResults([]);
      setDrawer(null);
      setToast(
        res.poTriggered
          ? 'Item added below alert level—restock order sent to supplier.'
          : 'New item added to shelf stock.'
      );
      await loadWorkspace();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not add item.');
    } finally {
      setSkuBusy(false);
    }
  };

  const handleSaveServicePrice = async (srv: PharmacyService) => {
    const priceVal = Number(servicePriceDrafts[srv.id]);
    if (Number.isNaN(priceVal) || priceVal < 0) return;
    try {
      await apiFetch(`/api/staff/services/${srv.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ priceCents: Math.round(priceVal * 100) }),
      });
      setToast(`Updated fee for ${srv.name}.`);
      await loadWorkspace();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not update service.');
    }
  };

  const handleToggleServiceActive = async (srv: PharmacyService) => {
    try {
      await apiFetch(`/api/staff/services/${srv.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !srv.active }),
      });
      setToast(`${srv.name} ${srv.active ? 'paused' : 'activated'}.`);
      await loadWorkspace();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not update service status.');
    }
  };

  const handleRecordServiceLog = async (e: React.FormEvent) => {
    e.preventDefault();
    setLogBusy(true);
    try {
      await apiFetch('/api/staff/service-logs', {
        method: 'POST',
        body: JSON.stringify({
          serviceId: logServiceId,
          patientName: logPatientName,
          resultValue: logResultValue,
          notes: logNotes,
        }),
      });
      setLogPatientName('');
      setLogResultValue('');
      setLogNotes('');
      setToast('Test result recorded.');
      await loadWorkspace();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not record test result.');
    } finally {
      setLogBusy(false);
    }
  };

  const handleCreateService = async (e: React.FormEvent) => {
    e.preventDefault();
    setSrvBusy(true);
    try {
      await apiFetch('/api/staff/services', {
        method: 'POST',
        body: JSON.stringify({
          name: srvName,
          category: srvCategory,
          turnaroundMinutes: srvTurnaround,
          priceCents: Math.round((Number(srvPriceDollars) || 20) * 100),
          notes: srvNotes,
        }),
      });
      setSrvName('');
      setSrvNotes('');
      setDrawer(null);
      setToast('New pharmacy service added.');
      await loadWorkspace();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not add service.');
    } finally {
      setSrvBusy(false);
    }
  };

  const handleReceivePo = async (poId: string) => {
    try {
      await apiFetch(`/api/staff/replenishments/${poId}/receive`, { method: 'POST' });
      setToast('Stock received and shelf count updated.');
      await loadWorkspace();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not mark stock received.');
    }
  };

  const handleOtcOrderStatus = async (
    orderId: string,
    status: 'confirmed' | 'ready_for_pickup' | 'dispatched'
  ) => {
    try {
      await apiFetch(`/api/staff/orders/${orderId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setToast(`Online order marked as ${status.replace(/_/g, ' ')}.`);
      await loadWorkspace();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not update online order.');
    }
  };

  const previewCalc = useMemo(() => {
    if (!selectedRx || !selectedPlan) return null;
    const uc = selectedRx.unitPriceCents;
    const dawMod = dawCode === '1' ? 0.94 : 1.0;
    const allowed = Math.max(500, Math.round(uc * selectedPlan.reimbursementRate * dawMod));
    const supplyMult = daysSupply >= 60 ? 2 : 1;
    const tierBase =
      formularyTier === 1
        ? selectedPlan.tier1CopayCents
        : formularyTier === 2
          ? selectedPlan.tier2CopayCents
          : selectedPlan.tier3CopayCents;
    const dedCents = Math.min(allowed, Math.max(0, Math.round((Number(deductibleDollars) || 0) * 100)));
    const rem = Math.max(0, allowed - dedCents);
    const copay = dedCents + Math.min(rem, tierBase * supplyMult + (dawCode === '2' ? 1500 : 0));
    const insurer = Math.max(0, allowed - copay);
    return { uc, allowed, dedCents, copay, insurer };
  }, [selectedRx, selectedPlan, dawCode, daysSupply, formularyTier, deductibleDollars]);

  const claimRuleHint = useMemo(() => {
    const code = overrideCode.trim().toUpperCase();
    if (
      dawCode === '2' &&
      selectedPlan &&
      (selectedPlan.id === 'plan_bcbs' || selectedPlan.payerName.toUpperCase().includes('NHIS')) &&
      code !== 'SCC-02'
    ) {
      return 'NHIS covers standard generics unless an exception code (SCC-02) is entered.';
    }
    if (formularyTier === 3 && (!code.startsWith('PA-') || code.length < 6)) {
      return 'Tier 3 specialist medicines need an approval code starting with PA- (e.g. PA-4821).';
    }
    if (daysSupply > 90 && code !== 'M0-1B') {
      return 'Packs over 90 days require pharmacist review code M0-1B.';
    }
    return null;
  }, [formularyTier, dawCode, daysSupply, selectedPlan, overrideCode]);

  const navItems: Array<{
    id: StaffTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: 'rx', label: 'Prescriptions', icon: ClipboardList },
    { id: 'pos', label: 'Walk-In Counter', icon: Receipt },
    { id: 'services', label: 'Tests & Services', icon: Activity },
    { id: 'claims', label: 'Insurance Claims', icon: Calculator },
    { id: 'inventory', label: 'Stock & Reorders', icon: Boxes },
    { id: 'consults', label: 'Messages', icon: MessageSquare },
  ];

  const mainContent = (
    <div className={embedded ? 'space-y-5' : 'mx-auto max-w-6xl p-4 sm:p-6 space-y-5'}>
      {embedded && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-2">
          <div className="flex flex-wrap gap-1.5">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors ${
                    active
                      ? 'bg-orange-600 text-white'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {item.label}
                  {item.id === 'inventory' && lowStockItems.length > 0 && (
                    <span
                      className={`font-mono text-[11px] font-bold tabular-nums ${
                        active ? 'text-orange-100' : 'text-red-600'
                      }`}
                    >
                      ({lowStockItems.length})
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {toast && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-xs font-medium text-orange-950">
          <span>{toast}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="font-semibold text-orange-700 hover:underline shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {loading ? (
        <div className="h-72 animate-pulse rounded-xl border border-slate-200 bg-white" />
      ) : activeTab === 'pos' ? (
        <POSTerminal
          inventory={inventory}
          services={services}
          prescriptions={prescriptions}
          claims={claims}
          recentOrders={otcOrders}
          posReceipts={posReceipts}
          drawerEvents={drawerEvents}
          cashierName={user.displayName}
          cashierRole={user.role}
          preselectedRxId={posPreselectRxId}
          onClearPreselectedRx={() => setPosPreselectRxId(null)}
          onOrderStatusChange={handleOtcOrderStatus}
          onSaleCompleted={async (msg) => {
            setToast(msg);
            await loadWorkspace();
          }}
        />
      ) : activeTab === 'services' ? (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 items-start">
            {/* Record Walk-In Test Reading */}
            <form
              onSubmit={handleRecordServiceLog}
              className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-5 space-y-3"
            >
              <div className="flex items-center justify-between">
                <h2 className="font-display text-base font-bold text-slate-900">
                  Record Test Reading
                </h2>
                <button
                  type="button"
                  onClick={() => setActiveTab('pos')}
                  className="rounded-md border border-slate-300 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:border-orange-500"
                >
                  Bill in POS
                </button>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">Test / Check</label>
                <select
                  value={logServiceId}
                  onChange={(e) => setLogServiceId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                >
                  {services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({formatMoney(s.priceCents)})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">Customer Name</label>
                <input
                  type="text"
                  required
                  value={logPatientName}
                  onChange={(e) => setLogPatientName(e.target.value)}
                  placeholder="e.g. Ama Serwaa Mensah or Walk-In"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Reading / Result
                </label>
                <input
                  type="text"
                  required
                  value={logResultValue}
                  onChange={(e) => setLogResultValue(e.target.value)}
                  placeholder="e.g. 122/78 mmHg, 5.6 mmol/L, Negative, Positive"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Pharmacist Advice (optional)
                </label>
                <input
                  type="text"
                  value={logNotes}
                  onChange={(e) => setLogNotes(e.target.value)}
                  placeholder="e.g. Advised low-salt meal, repeat check next week"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={logBusy}
                className="w-full rounded-lg bg-orange-600 py-2.5 text-xs font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
              >
                {logBusy ? 'Saving...' : 'Save Test Result'}
              </button>
            </form>

            {/* Manage Pharmacy Service Pricing & Status */}
            <section className="rounded-xl border border-slate-200 bg-white lg:col-span-7 overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
                <h2 className="font-display text-base font-bold text-slate-900">
                  Walk-In Tests &amp; Fee Menu ({services.length})
                </h2>
                <button
                  type="button"
                  onClick={() => setDrawer('new_service')}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-700"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add Service
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">Service</th>
                      <th className="px-4 py-2.5 font-semibold">Time</th>
                      <th className="px-4 py-2.5 font-semibold">Fee (GH₵)</th>
                      <th className="px-4 py-2.5 font-semibold">Status</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {services.map((srv) => (
                      <tr key={srv.id} className="hover:bg-slate-50/70">
                        <td className="px-4 py-2.5">
                          <div className="font-semibold text-slate-900">{srv.name}</div>
                          <div className="text-[11px] text-slate-500">{srv.category}</div>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-slate-600 tabular-nums whitespace-nowrap">
                          {srv.turnaroundMinutes}m
                        </td>
                        <td className="px-4 py-2.5">
                          <input
                            type="number"
                            step="0.5"
                            min="0"
                            value={servicePriceDrafts[srv.id] ?? (srv.priceCents / 100).toFixed(2)}
                            onChange={(e) =>
                              setServicePriceDrafts((prev) => ({
                                ...prev,
                                [srv.id]: e.target.value,
                              }))
                            }
                            className="w-20 rounded border border-slate-300 px-2 py-1 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                          />
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => handleToggleServiceActive(srv)}
                            className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${
                              srv.active
                                ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                                : 'border-slate-300 bg-slate-100 text-slate-600'
                            }`}
                          >
                            {srv.active ? 'Active' : 'Paused'}
                          </button>
                        </td>
                        <td className="px-4 py-2.5 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => handleSaveServicePrice(srv)}
                            className="rounded-md bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-slate-800"
                          >
                            Save
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          {/* Recent Test Logs */}
          <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="border-b border-slate-200 px-5 py-3.5">
              <h3 className="font-display text-sm font-bold text-slate-900">
                Recent Test Readings &amp; Counter Services ({serviceLogs.length})
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Date</th>
                    <th className="px-4 py-2.5 font-semibold">Customer</th>
                    <th className="px-4 py-2.5 font-semibold">Test / Service</th>
                    <th className="px-4 py-2.5 font-semibold">Result</th>
                    <th className="px-4 py-2.5 font-semibold">Notes</th>
                    <th className="px-4 py-2.5 font-semibold text-right">Fee</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {serviceLogs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                        No walk-in test logs saved yet.
                      </td>
                    </tr>
                  ) : (
                    serviceLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-slate-50/70">
                        <td className="px-4 py-2.5 font-mono text-[11px] text-slate-500 tabular-nums whitespace-nowrap">
                          {new Date(log.createdAt).toLocaleString('en-GH', {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </td>
                        <td className="px-4 py-2.5 font-semibold text-slate-900">
                          {log.patientName}
                        </td>
                        <td className="px-4 py-2.5 text-slate-700">{log.serviceName}</td>
                        <td className="px-4 py-2.5 font-mono font-semibold text-orange-700">
                          {log.resultValue}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">{log.notes || '—'}</td>
                        <td className="px-4 py-2.5 text-right font-mono font-semibold text-slate-900 tabular-nums">
                          {formatMoney(log.priceCents)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : activeTab === 'rx' ? (
        <div className="space-y-5">
          {/* Clean Single-Level Summary Strip */}
          <div className="grid grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-slate-200 rounded-xl border border-slate-200 bg-white lg:grid-cols-4">
            <div className="p-4">
              <p className="text-xs font-medium text-slate-500">Waiting to Check</p>
              <p className="mt-1 font-mono text-2xl font-bold text-slate-900 tabular-nums">
                {rxCounts.toCheck}
              </p>
            </div>
            <div className="p-4">
              <p className="text-xs font-medium text-slate-500">Insurance Hold</p>
              <p
                className={`mt-1 font-mono text-2xl font-bold tabular-nums ${
                  rxCounts.hold > 0 ? 'text-red-600' : 'text-slate-900'
                }`}
              >
                {rxCounts.hold}
              </p>
            </div>
            <div className="p-4">
              <p className="text-xs font-medium text-slate-500">Ready for Pickup</p>
              <p className="mt-1 font-mono text-2xl font-bold text-emerald-700 tabular-nums">
                {rxCounts.ready}
              </p>
            </div>
            <div className="p-4">
              <p className="text-xs font-medium text-slate-500">Handed Over</p>
              <p className="mt-1 font-mono text-2xl font-bold text-slate-700 tabular-nums">
                {rxCounts.dispensed}
              </p>
            </div>
          </div>

          {/* Main Prescriptions / Care Plans Panel */}
          <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="flex flex-col justify-between gap-3 border-b border-slate-200 px-5 py-3.5 sm:flex-row sm:items-center">
              <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 w-fit">
                <button
                  type="button"
                  onClick={() => setRxSubTab('queue')}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                    rxSubTab === 'queue'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Prescription Queue ({prescriptions.length})
                </button>
                <button
                  type="button"
                  onClick={() => setRxSubTab('care_plans')}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                    rxSubTab === 'care_plans'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Care Plans ({carePlans.length})
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {rxSubTab === 'queue' ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setDrawer('patient_phi')}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-orange-500"
                    >
                      <ShieldCheck className="h-3.5 w-3.5 text-orange-600" />
                      Allergies &amp; Insurance
                    </button>
                    <button
                      type="button"
                      onClick={() => setDrawer('new_rx')}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-orange-700"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      New Prescription
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setDrawer('new_care_plan')}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-orange-700"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Care Plan
                  </button>
                )}
              </div>
            </div>

            {rxSubTab === 'queue' ? (
              <>
                <div className="flex flex-col justify-between gap-3 border-b border-slate-200 bg-slate-50/70 px-5 py-3 sm:flex-row sm:items-center">
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        ['ALL', 'All'],
                        ['submitted', 'New'],
                        ['verifying', 'To Check'],
                        ['insurance_hold', 'Hold'],
                        ['ready', 'Ready'],
                        ['dispensed', 'Handed Over'],
                      ] as const
                    ).map(([st, label]) => (
                      <button
                        key={st}
                        type="button"
                        onClick={() => setRxStatusFilter(st)}
                        className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                          rxStatusFilter === st
                            ? 'bg-slate-900 text-white'
                            : 'border border-slate-200 bg-white text-slate-600 hover:border-orange-400'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="relative w-full sm:w-64">
                    <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
                    <input
                      type="text"
                      value={rxSearch}
                      onChange={(e) => setRxSearch(e.target.value)}
                      placeholder="Search Rx #, patient, medicine..."
                      className="w-full rounded-lg border border-slate-300 bg-white pl-8 pr-3 py-1.5 text-xs focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                      <tr>
                        <th className="px-4 py-3 font-semibold">Rx # &amp; Patient</th>
                        <th className="px-4 py-3 font-semibold">Medicine &amp; Allergies</th>
                        <th className="px-4 py-3 font-semibold">Status</th>
                        <th className="px-4 py-3 font-semibold text-right">Next Step</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredPrescriptions.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-10 text-center text-xs text-slate-500">
                            No prescriptions match this filter.
                          </td>
                        </tr>
                      ) : (
                        filteredPrescriptions.map((rx) => {
                          const patient = patients.find((p) => p.id === rx.patientId);
                          return (
                            <tr key={rx.id} className="hover:bg-slate-50/70">
                              <td className="px-4 py-3 align-top">
                                <div className="font-mono font-bold text-slate-900 tabular-nums">
                                  {rx.rxNumber}
                                </div>
                                <div className="mt-0.5 font-semibold text-slate-800">
                                  {rx.patientName}
                                </div>
                                <div className="text-[11px] text-slate-500">{rx.prescriberName}</div>
                              </td>
                              <td className="px-4 py-3 align-top">
                                <div className="font-semibold text-slate-900">
                                  {rx.medicationName}{' '}
                                  <span className="font-mono text-[11px] font-normal text-slate-500 tabular-nums">
                                    · {rx.quantity} qty ({rx.daysSupply}d)
                                  </span>
                                </div>
                                <div className="mt-0.5 text-slate-600">{rx.dosageInstructions}</div>
                                {patient?.phi && (
                                  <div className="mt-1 flex items-center gap-2 text-[11px]">
                                    <span className="font-medium text-red-700">
                                      Allergies: {patient.phi.allergies.join(', ')}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setPhiPatientId(patient.id);
                                        setDrawer('patient_phi');
                                      }}
                                      className="font-semibold text-slate-500 underline hover:text-orange-600"
                                    >
                                      Edit
                                    </button>
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-3 align-top whitespace-nowrap">
                                <span
                                  className={`font-semibold ${
                                    rx.status === 'dispensed' || rx.status === 'ready'
                                      ? 'text-emerald-700'
                                      : rx.status === 'insurance_hold'
                                        ? 'text-red-600'
                                        : 'text-orange-600'
                                  }`}
                                >
                                  {RX_STATUS_LABELS[rx.status]}
                                </span>
                              </td>
                              <td className="px-4 py-3 align-top text-right">
                                <div className="inline-flex flex-wrap justify-end gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSelectedRxId(rx.id);
                                      setActiveTab('claims');
                                    }}
                                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:border-orange-500"
                                  >
                                    Check Insurance
                                  </button>
                                  {rx.status !== 'dispensed' && (
                                    <>
                                      {rx.status !== 'ready' && (
                                        <button
                                          type="button"
                                          onClick={() => handleRxStatusChange(rx.id, 'ready')}
                                          className="rounded-lg border border-orange-200 bg-orange-50 px-2.5 py-1.5 text-xs font-semibold text-orange-700 hover:bg-orange-100"
                                        >
                                          Mark Ready
                                        </button>
                                      )}
                                      {rx.status === 'ready' && (
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setPosPreselectRxId(rx.id);
                                            setActiveTab('pos');
                                          }}
                                          className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-800 hover:border-orange-500"
                                        >
                                          Ring Up
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => handleRxStatusChange(rx.id, 'dispensed')}
                                        className="rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-700"
                                      >
                                        Hand Over
                                      </button>
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              /* Care Plans Sub-View */
              <div className="p-5">
                {carePlans.length === 0 ? (
                  <div className="py-10 text-center text-xs text-slate-500">
                    No care plans saved yet.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {carePlans.map((cp) => {
                      const isEditing = editingCarePlanId === cp.id;
                      return (
                        <div
                          key={cp.id}
                          className="rounded-lg border border-slate-200 bg-white p-4 text-xs space-y-2"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <span className="font-bold text-slate-900">{cp.patientName}</span>
                              <span className="mx-1.5 text-slate-300">·</span>
                              <span className="font-semibold text-orange-700">
                                {cp.conditionFocus}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                                Next check: {cp.followUpDate}
                              </span>
                              {!isEditing && (
                                <button
                                  type="button"
                                  onClick={() => startEditCarePlan(cp)}
                                  className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:border-orange-500"
                                >
                                  <Edit3 className="h-3 w-3 text-orange-600" />
                                  Edit
                                </button>
                              )}
                            </div>
                          </div>

                          {isEditing ? (
                            <div className="space-y-2 pt-1">
                              <textarea
                                rows={2}
                                value={editCpGoals}
                                onChange={(e) => setEditCpGoals(e.target.value)}
                                className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs focus:border-orange-500 focus:outline-none"
                                placeholder="Care plan goals"
                              />
                              <input
                                type="text"
                                value={editCpWarnings}
                                onChange={(e) => setEditCpWarnings(e.target.value)}
                                className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs focus:border-orange-500 focus:outline-none"
                                placeholder="Medicine warnings"
                              />
                              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                <input
                                  type="text"
                                  value={editCpAdherence}
                                  onChange={(e) => setEditCpAdherence(e.target.value)}
                                  className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs focus:border-orange-500 focus:outline-none"
                                  placeholder="Follow-up notes"
                                />
                                <input
                                  type="date"
                                  value={editCpFollowUp}
                                  onChange={(e) => setEditCpFollowUp(e.target.value)}
                                  className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-xs focus:border-orange-500 focus:outline-none"
                                />
                              </div>
                              <div className="flex justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => setEditingCarePlanId(null)}
                                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  disabled={editCpBusy}
                                  onClick={() => handleSaveCarePlanEdit(cp.id)}
                                  className="rounded-md bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
                                >
                                  {editCpBusy ? 'Saving...' : 'Save'}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <p className="text-slate-700 leading-relaxed">{cp.clinicalGoals}</p>
                              <p className="font-medium text-amber-800">
                                Watch for: {cp.interactionWarnings}
                              </p>
                              {cp.adherenceNotes && (
                                <p className="text-[11px] text-slate-500">
                                  Notes: {cp.adherenceNotes}
                                </p>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      ) : activeTab === 'claims' ? (
        /* NHIS & PRIVATE HEALTH INSURANCE CLAIMS */
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 items-start">
          <form
            onSubmit={handleRunClaim}
            className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-7 space-y-4"
          >
            <h2 className="font-display text-base font-bold text-slate-900">
              Insurance Claim Check
            </h2>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-semibold text-slate-700">Prescription</label>
                <select
                  value={selectedRx?.id || ''}
                  onChange={(e) => setSelectedRxId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                >
                  {prescriptions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.rxNumber} · {r.patientName} ({r.medicationName})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Health Insurance Scheme
                </label>
                <select
                  value={selectedPlanId}
                  onChange={(e) => handlePlanChange(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                >
                  {insurancePlans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.payerName} ({p.pcn})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700">Scheme BIN</label>
                <input
                  type="text"
                  value={claimBin}
                  onChange={(e) => setClaimBin(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">Code / PCN</label>
                <input
                  type="text"
                  value={claimPcn}
                  onChange={(e) => setClaimPcn(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus:border-orange-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">Group / Card ID</label>
                <input
                  type="text"
                  value={claimGroup}
                  onChange={(e) => setClaimGroup(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus:border-orange-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700">Medicine Tier</label>
                <select
                  value={formularyTier}
                  onChange={(e) => setFormularyTier(Number(e.target.value) as 1 | 2 | 3)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs focus:border-orange-500 focus:outline-none"
                >
                  <option value={1}>Tier 1 · Standard Generic</option>
                  <option value={2}>Tier 2 · Brand Medicine</option>
                  <option value={3}>Tier 3 · Specialist (Needs PA)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">Brand Option</label>
                <select
                  value={dawCode}
                  onChange={(e) => setDawCode(e.target.value as '0' | '1' | '2')}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs focus:border-orange-500 focus:outline-none"
                >
                  <option value="0">0 · Standard Substitution</option>
                  <option value="1">1 · Doctor Specified Brand</option>
                  <option value="2">2 · Patient Asked for Brand</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">Days Supply</label>
                <input
                  type="number"
                  min={1}
                  max={180}
                  value={daysSupply}
                  onChange={(e) => setDaysSupply(Number(e.target.value) || 30)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Deductible (GH₵)
                </label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={deductibleDollars}
                  onChange={(e) => setDeductibleDollars(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                />
              </div>
            </div>

            {claimRuleHint && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" />
                <span>{claimRuleHint}</span>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 border-t border-slate-200 pt-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Approval / Exception Code (if needed)
                </label>
                <input
                  type="text"
                  value={overrideCode}
                  onChange={(e) => setOverrideCode(e.target.value)}
                  placeholder="e.g. PA-4821, SCC-02, 03, or M0-1B"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs uppercase focus:border-orange-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Pharmacist Note
                </label>
                <input
                  type="text"
                  value={overrideNotes}
                  onChange={(e) => setOverrideNotes(e.target.value)}
                  placeholder="Reason or doctor approval reference..."
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={claimBusy}
              className="w-full rounded-lg bg-orange-600 py-3 text-xs font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
            >
              {claimBusy ? 'Checking Scheme...' : 'Check & Save Claim'}
            </button>
          </form>

          {/* Right Column: Live Split + Existing Result + Claim History */}
          <div className="space-y-4 lg:col-span-5">
            {previewCalc && (
              <div className="rounded-xl border border-slate-200 bg-white p-5">
                <h3 className="font-display text-sm font-bold text-slate-900">Cost Split Estimate</h3>
                <div className="mt-3 space-y-2 text-xs">
                  <div className="flex justify-between text-slate-600">
                    <span>Retail Price</span>
                    <span className="font-mono tabular-nums">{formatMoney(previewCalc.uc)}</span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Scheme Agreed Price</span>
                    <span className="font-mono tabular-nums">
                      {formatMoney(previewCalc.allowed)}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Deductible Applied</span>
                    <span className="font-mono tabular-nums">
                      {formatMoney(previewCalc.dedCents)}
                    </span>
                  </div>
                  <div className="flex justify-between border-t border-slate-200 pt-2 font-bold text-emerald-700">
                    <span>Insurance Pays</span>
                    <span className="font-mono text-sm tabular-nums">
                      {formatMoney(previewCalc.insurer)}
                    </span>
                  </div>
                  <div className="flex justify-between font-bold text-orange-600">
                    <span>Patient Pays</span>
                    <span className="font-mono text-sm tabular-nums">
                      {formatMoney(previewCalc.copay)}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {existingClaimForRx && (
              <div
                className={`rounded-xl border p-5 ${
                  existingClaimForRx.claimStatus === 'rejected'
                    ? 'border-red-300 bg-red-50'
                    : 'border-emerald-200 bg-emerald-50/70'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-bold text-slate-900 tabular-nums">
                    {existingClaimForRx.claimNumber}
                  </span>
                  <span
                    className={`text-xs font-bold uppercase ${
                      existingClaimForRx.claimStatus === 'rejected'
                        ? 'text-red-700'
                        : 'text-emerald-700'
                    }`}
                  >
                    {existingClaimForRx.claimStatus === 'rejected' ? 'On Hold' : 'Approved'}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-slate-800">
                  {existingClaimForRx.rejectionMessage}
                </p>
                <p className="mt-2 font-mono text-xs font-semibold text-slate-700 tabular-nums">
                  Saved Split: Insurance {formatMoney(existingClaimForRx.insurerPaidCents)} · Patient{' '}
                  {formatMoney(existingClaimForRx.patientCopayCents)}
                </p>
              </div>
            )}

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <h3 className="font-display text-sm font-bold text-slate-900">Recent Claims</h3>
              <div className="mt-2 divide-y divide-slate-100">
                {claims.map((clm) => (
                  <button
                    key={clm.id}
                    type="button"
                    onClick={() => setSelectedRxId(clm.prescriptionId)}
                    className="flex w-full items-center justify-between py-2.5 text-left text-xs hover:bg-slate-50"
                  >
                    <div className="min-w-0 pr-2">
                      <span className="font-mono font-bold text-slate-900 tabular-nums">
                        {clm.claimNumber}
                      </span>
                      <span className="mx-1.5 text-slate-400">·</span>
                      <span className="text-slate-700 truncate">{clm.medicationName}</span>
                    </div>
                    <span
                      className={`font-semibold uppercase shrink-0 ${
                        clm.claimStatus === 'rejected' ? 'text-red-600' : 'text-emerald-700'
                      }`}
                    >
                      {clm.claimStatus === 'rejected' ? 'Held' : 'Approved'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : activeTab === 'inventory' ? (
        /* STOCK, RESTOCK ORDERS & ONLINE SHOP ORDERS */
        <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="flex flex-col justify-between gap-3 border-b border-slate-200 px-5 py-3.5 sm:flex-row sm:items-center">
            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 w-fit">
              <button
                type="button"
                onClick={() => setInvSubTab('stock')}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  invSubTab === 'stock'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Shelf Stock ({inventory.length})
              </button>
              <button
                type="button"
                onClick={() => setInvSubTab('reorders')}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  invSubTab === 'reorders'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Restock Orders ({replenishments.length})
              </button>
              <button
                type="button"
                onClick={() => setInvSubTab('online_orders')}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  invSubTab === 'online_orders'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Online Orders ({otcOrders.length})
              </button>
            </div>

            <button
              type="button"
              onClick={() => setDrawer('new_sku')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-orange-700 w-fit"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Medicine / Item
            </button>
          </div>

          {invSubTab === 'stock' ? (
            <>
              <div className="space-y-3 border-b border-slate-200 bg-slate-50/70 px-5 py-3">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                  <div className="relative w-full sm:w-72">
                    <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
                    <input
                      type="text"
                      value={invSearch}
                      onChange={(e) => setInvSearch(e.target.value)}
                      placeholder="Search item name, code, or batch..."
                      className="w-full rounded-lg border border-slate-300 bg-white pl-8 pr-3 py-1.5 text-xs focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-700">
                    <input
                      type="checkbox"
                      checked={shortageOnly}
                      onChange={(e) => setShortageOnly(e.target.checked)}
                      className="h-4 w-4 accent-orange-600"
                    />
                    Low Stock Only ({lowStockItems.length})
                  </label>
                </div>

                {/* Category Filter Tabs */}
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setInvCategoryFilter('ALL')}
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                      invCategoryFilter === 'ALL'
                        ? 'bg-slate-900 text-white'
                        : 'border border-slate-200 bg-white text-slate-600 hover:border-orange-400'
                    }`}
                  >
                    All Categories ({inventory.length})
                  </button>
                  {INVENTORY_CATEGORIES.map((cat) => {
                    const catCount = inventory.filter((i) => i.category === cat).length;
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setInvCategoryFilter(cat)}
                        className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                          invCategoryFilter === cat
                            ? 'bg-slate-900 text-white'
                            : 'border border-slate-200 bg-white text-slate-600 hover:border-orange-400'
                        }`}
                      >
                        {cat} ({catCount})
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Item &amp; Code</th>
                      <th className="px-4 py-3 font-semibold">Batch &amp; Expiry</th>
                      <th className="px-4 py-3 font-semibold">In Stock</th>
                      <th className="px-4 py-3 font-semibold">Alert At</th>
                      <th className="px-4 py-3 font-semibold">Auto-Order</th>
                      <th className="px-4 py-3 font-semibold">Status</th>
                      <th className="px-4 py-3 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {groupedInventory.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-4 py-10 text-center text-xs text-slate-500">
                          No medicines or items match this filter.
                        </td>
                      </tr>
                    ) : (
                      groupedInventory.map((group) => {
                        const groupLowCount = group.items.filter(
                          (i) => i.stockQuantity <= i.reorderThreshold
                        ).length;
                        return (
                          <React.Fragment key={group.category}>
                            <tr className="bg-slate-100/80 border-y border-slate-200">
                              <td colSpan={7} className="px-4 py-2">
                                <div className="flex items-center justify-between">
                                  <span className="font-display text-xs font-bold text-slate-900">
                                    {group.category}
                                  </span>
                                  <span className="font-mono text-[11px] font-semibold text-slate-600 tabular-nums">
                                    {group.items.length} items
                                    {groupLowCount > 0 && (
                                      <span className="ml-2 text-red-600">
                                        · {groupLowCount} low
                                      </span>
                                    )}
                                  </span>
                                </div>
                              </td>
                            </tr>
                            {group.items.map((item) => {
                              const draft = thresholdDrafts[item.id] || {
                                stock: item.stockQuantity,
                                threshold: item.reorderThreshold,
                              };
                              const isOut = item.stockQuantity <= 0;
                              const isLow = item.stockQuantity <= item.reorderThreshold;
                              const hasOpenPo = replenishments.some(
                                (po) => po.inventoryId === item.id && po.status !== 'received'
                              );
                              return (
                                <tr key={item.id} className="hover:bg-slate-50/70">
                                  <td className="px-4 py-3">
                                    <div className="flex items-center gap-3">
                                      <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-white p-0.5 flex items-center justify-center">
                                        {item.imageUrl ? (
                                          <img
                                            src={item.imageUrl}
                                            alt={item.name}
                                            className="h-full w-full object-contain"
                                            loading="lazy"
                                          />
                                        ) : (
                                          <Pill className="h-4 w-4 text-slate-300" />
                                        )}
                                      </div>
                                      <div className="min-w-0">
                                        <div className="font-semibold text-slate-900">{item.name}</div>
                                        <div className="font-mono text-[11px] text-slate-500 tabular-nums">
                                          {item.requiresPrescription ? 'Rx Only' : 'OTC'} ·{' '}
                                          {formatMoney(item.unitPriceCents)} · {item.ndcCode}
                                        </div>
                                        {item.manufacturerName && (
                                          <div className="text-[11px] text-slate-500 truncate max-w-[260px]">
                                            {item.manufacturerName}
                                            {item.activeIngredient ? ` · ${item.activeIngredient}` : ''}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </td>
                                  <td className="px-4 py-3 font-mono text-[11px] text-slate-600 tabular-nums">
                                    {item.lotNumber}
                                    <br />
                                    Exp {item.expiryDate}
                                  </td>
                                  <td className="px-4 py-3">
                                    <input
                                      type="number"
                                      min={0}
                                      value={draft.stock}
                                      onChange={(e) =>
                                        setThresholdDrafts((prev) => ({
                                          ...prev,
                                          [item.id]: {
                                            ...draft,
                                            stock: Number(e.target.value) || 0,
                                          },
                                        }))
                                      }
                                      className="w-20 rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                                    />
                                  </td>
                                  <td className="px-4 py-3">
                                    <input
                                      type="number"
                                      min={1}
                                      value={draft.threshold}
                                      onChange={(e) =>
                                        setThresholdDrafts((prev) => ({
                                          ...prev,
                                          [item.id]: {
                                            ...draft,
                                            threshold: Number(e.target.value) || 1,
                                          },
                                        }))
                                      }
                                      className="w-20 rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                                    />
                                  </td>
                                  <td className="px-4 py-3">
                                    <button
                                      type="button"
                                      onClick={() => handleToggleAutoReorder(item)}
                                      className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                                        item.autoReorderEnabled
                                          ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                                          : 'border-slate-300 bg-slate-100 text-slate-600'
                                      }`}
                                    >
                                      {item.autoReorderEnabled ? 'On' : 'Off'}
                                    </button>
                                  </td>
                                  <td className="px-4 py-3 whitespace-nowrap">
                                    <span
                                      className={`font-semibold ${
                                        isOut
                                          ? 'text-red-600'
                                          : isLow
                                            ? 'text-amber-700'
                                            : 'text-emerald-700'
                                      }`}
                                    >
                                      {isOut ? 'Out of Stock' : isLow ? 'Low Stock' : 'In Stock'}
                                    </span>
                                  </td>
                                  <td className="px-4 py-3 text-right whitespace-nowrap">
                                    <div className="inline-flex items-center gap-2">
                                      <button
                                        type="button"
                                        onClick={() => setSelectedInventoryInfo(item)}
                                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:border-orange-500 hover:text-orange-700"
                                      >
                                        <Info className="h-3.5 w-3.5" />
                                        Info
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleSaveStockThreshold(item)}
                                        className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                                      >
                                        Save
                                      </button>
                                      <button
                                        type="button"
                                        disabled={hasOpenPo}
                                        onClick={() => handleManualReorder(item)}
                                        className="rounded-lg border border-orange-300 bg-orange-50 px-2.5 py-1.5 text-xs font-semibold text-orange-700 hover:bg-orange-100 disabled:opacity-40"
                                      >
                                        {hasOpenPo ? 'Ordered' : 'Order Stock'}
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </React.Fragment>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : invSubTab === 'reorders' ? (
            <div className="divide-y divide-slate-100">
              {replenishments.length === 0 ? (
                <div className="p-10 text-center text-xs text-slate-500">
                  No restock orders yet.
                </div>
              ) : (
                replenishments.map((po) => (
                  <div
                    key={po.id}
                    className="flex flex-col justify-between gap-3 px-5 py-4 sm:flex-row sm:items-center"
                  >
                    <div className="text-xs space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <PackagePlus className="h-3.5 w-3.5 text-orange-600" />
                        <span className="font-mono font-bold text-slate-900 tabular-nums">
                          {po.poNumber}
                        </span>
                        <span className="font-semibold text-slate-800">{po.medicationName}</span>
                        <span
                          className={`font-semibold ${
                            po.status === 'received'
                              ? 'text-emerald-700'
                              : po.status === 'awaiting_supplier'
                                ? 'text-amber-700'
                                : 'text-orange-600'
                          }`}
                        >
                          · {PO_STATUS_LABELS[po.status] || po.status}
                        </span>
                      </div>
                      <p className="text-slate-600">
                        Supplier: {po.supplierName} · Qty {po.confirmedQty || po.requestedQty}
                        {po.scheduledDeliveryDate &&
                          ` · Delivery ${po.scheduledDeliveryDate} (${po.deliveryWindow})`}
                        {po.batchNumber && ` · Batch ${po.batchNumber}`}
                      </p>
                    </div>
                    <div className="shrink-0">
                      {po.status === 'confirmed_scheduled' || po.status === 'in_transit' ? (
                        <button
                          type="button"
                          onClick={() => handleReceivePo(po.id)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Receive Stock
                        </button>
                      ) : po.status === 'received' ? (
                        <span className="text-xs font-semibold text-emerald-700">In Shelf Stock</span>
                      ) : (
                        <span className="text-xs text-slate-500">Waiting for Supplier</span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : (
            /* Online Orders */
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Order #</th>
                    <th className="px-4 py-3 font-semibold">Customer &amp; Delivery</th>
                    <th className="px-4 py-3 font-semibold">Items</th>
                    <th className="px-4 py-3 font-semibold text-right">Total</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold text-right">Update</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {otcOrders.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                        No online orders yet.
                      </td>
                    </tr>
                  ) : (
                    otcOrders.map((ord) => (
                      <tr key={ord.id} className="hover:bg-slate-50/70">
                        <td className="px-4 py-3 font-mono font-bold text-slate-900 tabular-nums">
                          {ord.orderNumber}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-slate-900">{ord.customerName}</div>
                          <div className="text-[11px] text-slate-500">
                            {ord.fulfillmentType.toUpperCase()} · {ord.shippingAddress}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-700">
                          {ord.items.map((it) => `${it.quantity}× ${it.name}`).join(', ')}
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-semibold text-slate-900 tabular-nums">
                          {formatMoney(ord.totalCents)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span
                            className={`font-semibold uppercase ${
                              ord.status === 'dispatched'
                                ? 'text-emerald-700'
                                : ord.status === 'ready_for_pickup'
                                  ? 'text-orange-600'
                                  : 'text-slate-700'
                            }`}
                          >
                            {ord.status.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          <div className="inline-flex gap-1.5">
                            {ord.status !== 'ready_for_pickup' && ord.status !== 'dispatched' && (
                              <button
                                type="button"
                                onClick={() => handleOtcOrderStatus(ord.id, 'ready_for_pickup')}
                                className="rounded-md border border-orange-300 bg-orange-50 px-2.5 py-1 text-[11px] font-semibold text-orange-700 hover:bg-orange-100"
                              >
                                Mark Ready
                              </button>
                            )}
                            {ord.status !== 'dispatched' && (
                              <button
                                type="button"
                                onClick={() => handleOtcOrderStatus(ord.id, 'dispatched')}
                                className="rounded-md bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-slate-800"
                              >
                                Handed Over
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : (
        <ConsultationChat user={user} token={token} />
      )}

      {/* Clean Modal Drawers for Forms (Keep Workspace Uncluttered) */}
      {drawer && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-xs overflow-y-auto"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="font-display text-base font-bold text-slate-900">
                {drawer === 'new_rx'
                  ? 'Add New Prescription'
                  : drawer === 'patient_phi'
                    ? 'Patient Allergies & Insurance Card'
                    : drawer === 'new_care_plan'
                      ? 'New Patient Care Plan'
                      : drawer === 'new_service'
                        ? 'Add Pharmacy Service / Test'
                        : 'Add New Medicine or Item'}
              </h3>
              <button
                type="button"
                onClick={() => setDrawer(null)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {drawer === 'new_rx' && (
              <form onSubmit={handleCreatePrescription} className="mt-4 space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Patient</label>
                  <select
                    value={newRxPatientId}
                    onChange={(e) => setNewRxPatientId(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                  >
                    {patients.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName} ({p.email})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Medicine</label>
                  <select
                    value={newRxInventoryId}
                    onChange={(e) => setNewRxInventoryId(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                  >
                    {inventory.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} ({item.stockQuantity} in stock)
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Doctor &amp; Clinic / MDC #
                  </label>
                  <input
                    type="text"
                    required
                    value={newRxPrescriber}
                    onChange={(e) => setNewRxPrescriber(e.target.value)}
                    placeholder="Dr. Kwame Boateng (Korle-Bu)"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    How to Take It
                  </label>
                  <input
                    type="text"
                    required
                    value={newRxDosage}
                    onChange={(e) => setNewRxDosage(e.target.value)}
                    placeholder="Take 1 tablet by mouth daily after meals"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                  />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">Qty</label>
                    <input
                      type="number"
                      min={1}
                      value={newRxQty}
                      onChange={(e) => setNewRxQty(Number(e.target.value) || 30)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">Days</label>
                    <input
                      type="number"
                      min={1}
                      max={180}
                      value={newRxDaysSupply}
                      onChange={(e) => setNewRxDaysSupply(Number(e.target.value) || 30)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">Refills</label>
                    <input
                      type="number"
                      min={0}
                      max={12}
                      value={newRxRefills}
                      onChange={(e) => setNewRxRefills(Number(e.target.value) || 0)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setDrawer(null)}
                    className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-600"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={newRxBusy}
                    className="rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
                  >
                    {newRxBusy ? 'Saving...' : 'Save Prescription'}
                  </button>
                </div>
              </form>
            )}

            {drawer === 'patient_phi' && (
              <form onSubmit={handleSavePatientPhi} className="mt-4 space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Patient</label>
                  <select
                    value={phiPatientId}
                    onChange={(e) => setPhiPatientId(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold focus:border-orange-500 focus:outline-none"
                  >
                    {patients.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName} ({p.email})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Known Allergies (comma-separated)
                  </label>
                  <input
                    type="text"
                    value={phiAllergiesText}
                    onChange={(e) => setPhiAllergiesText(e.target.value)}
                    placeholder="Penicillin, Sulfa Drugs"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">
                      Insurance Scheme
                    </label>
                    <input
                      type="text"
                      value={phiProvider}
                      onChange={(e) => setPhiProvider(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">Member ID</label>
                    <input
                      type="text"
                      value={phiMemberId}
                      onChange={(e) => setPhiMemberId(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">BIN</label>
                    <input
                      type="text"
                      value={phiBin}
                      onChange={(e) => setPhiBin(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">PCN</label>
                    <input
                      type="text"
                      value={phiPcn}
                      onChange={(e) => setPhiPcn(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">Group #</label>
                    <input
                      type="text"
                      value={phiGroup}
                      onChange={(e) => setPhiGroup(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setDrawer(null)}
                    className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-600"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={phiSaving}
                    className="rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
                  >
                    {phiSaving ? 'Saving...' : 'Save Patient Details'}
                  </button>
                </div>
              </form>
            )}

            {drawer === 'new_care_plan' && (
              <form onSubmit={handleCreateCarePlan} className="mt-4 space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Patient</label>
                  <select
                    value={cpPatientId}
                    onChange={(e) => setCpPatientId(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                  >
                    {patients.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName} ({p.phi?.insuranceProvider || 'Cash'})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Health Focus
                  </label>
                  <input
                    type="text"
                    required
                    value={cpFocus}
                    onChange={(e) => setCpFocus(e.target.value)}
                    placeholder="e.g. Blood Pressure Check, Diabetes Care"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Care Plan &amp; Follow-Up Goals
                  </label>
                  <textarea
                    required
                    rows={3}
                    value={cpGoals}
                    onChange={(e) => setCpGoals(e.target.value)}
                    placeholder="What to check and keep track of..."
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Medicine / Allergy Warnings
                  </label>
                  <input
                    type="text"
                    value={cpWarnings}
                    onChange={(e) => setCpWarnings(e.target.value)}
                    placeholder="Anything to watch out for..."
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Next Follow-Up Date
                  </label>
                  <input
                    type="date"
                    value={cpFollowUp}
                    onChange={(e) => setCpFollowUp(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus:border-orange-500 focus:outline-none"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setDrawer(null)}
                    className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-600"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={cpBusy}
                    className="rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
                  >
                    {cpBusy ? 'Saving...' : 'Save Care Plan'}
                  </button>
                </div>
              </form>
            )}

            {drawer === 'new_sku' && (
              <form onSubmit={handleCreateSku} className="mt-4 space-y-3 max-h-[75vh] overflow-y-auto pr-1">
                {/* Live Official Manufacturer / DailyMed + OpenFDA Lookup */}
                <div className="rounded-xl border border-orange-200 bg-orange-50/50 p-3 space-y-2">
                  <label className="block text-xs font-semibold text-slate-800">
                    Pull Official Drug Info &amp; Picture (DailyMed / OpenFDA)
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={lookupQuery}
                      onChange={(e) => setLookupQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleOfficialLookup();
                        }
                      }}
                      placeholder="Type medicine name e.g. Panadol, Coartem, Amlodipine..."
                      className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs focus:border-orange-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={lookupBusy}
                      onClick={handleOfficialLookup}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                    >
                      {lookupBusy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Search className="h-3.5 w-3.5" />
                      )}
                      {lookupBusy ? 'Searching...' : 'Pull Info'}
                    </button>
                  </div>
                  {lookupError && <p className="text-[11px] font-medium text-red-600">{lookupError}</p>}
                  {lookupResults.length > 0 && (
                    <div className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white max-h-48 overflow-y-auto">
                      {lookupResults.map((hit, idx) => (
                        <button
                          key={`${hit.name}-${idx}`}
                          type="button"
                          onClick={() => applyLookupResult(hit)}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-orange-50 transition-colors"
                        >
                          <div className="h-9 w-9 shrink-0 overflow-hidden rounded border border-slate-200 bg-white p-0.5 flex items-center justify-center">
                            {hit.imageUrl ? (
                              <img
                                src={hit.imageUrl}
                                alt={hit.name}
                                className="h-full w-full object-contain"
                              />
                            ) : (
                              <Pill className="h-4 w-4 text-slate-300" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-semibold text-slate-900 truncate">{hit.name}</p>
                            <p className="text-[11px] text-slate-500 truncate">
                              {hit.manufacturerName} · {hit.activeIngredient || hit.dosageForm}
                            </p>
                          </div>
                          <span className="text-[11px] font-semibold text-orange-600 shrink-0">
                            Use
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">
                      Item Code / Barcode
                    </label>
                    <input
                      type="text"
                      required
                      value={skuNdc}
                      onChange={(e) => setSkuNdc(e.target.value)}
                      placeholder="GHA-8821-01"
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">Category</label>
                    <select
                      value={skuCategory}
                      onChange={(e) => {
                        const cat = e.target.value as InventoryCategory;
                        setSkuCategory(cat);
                        if (cat === 'Chronic & Heart') setSkuRequiresRx(true);
                      }}
                      className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                    >
                      {INVENTORY_CATEGORIES.map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={skuRequiresRx}
                    onChange={(e) => setSkuRequiresRx(e.target.checked)}
                    className="h-4 w-4 accent-orange-600"
                  />
                  Requires Prescription (Rx Only — hidden from retail shop)
                </label>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Medicine / Product Name
                  </label>
                  <input
                    type="text"
                    required
                    value={skuName}
                    onChange={(e) => setSkuName(e.target.value)}
                    placeholder="Amoxicillin 500mg Capsules"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">
                      Manufacturer
                    </label>
                    <input
                      type="text"
                      value={skuManufacturer}
                      onChange={(e) => setSkuManufacturer(e.target.value)}
                      placeholder="e.g. Haleon, Pfizer, Vitabiotics"
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">
                      Active Ingredient(s)
                    </label>
                    <input
                      type="text"
                      value={skuActiveIngredient}
                      onChange={(e) => setSkuActiveIngredient(e.target.value)}
                      placeholder="e.g. Paracetamol 500mg"
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">
                      Dosage Form / Pack Size
                    </label>
                    <input
                      type="text"
                      value={skuDosageForm}
                      onChange={(e) => setSkuDosageForm(e.target.value)}
                      placeholder="e.g. Film-coated tablets · Box of 24"
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">
                      Short Description / Uses
                    </label>
                    <input
                      type="text"
                      value={skuDesc}
                      onChange={(e) => setSkuDesc(e.target.value)}
                      placeholder="Pack details and main use"
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">
                      Usage Directions
                    </label>
                    <input
                      type="text"
                      value={skuUsageDirections}
                      onChange={(e) => setSkuUsageDirections(e.target.value)}
                      placeholder="Adults take 1-2 tablets every 6 hours..."
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">
                      Safety Warnings
                    </label>
                    <input
                      type="text"
                      value={skuWarnings}
                      onChange={(e) => setSkuWarnings(e.target.value)}
                      placeholder="Do not exceed daily dose..."
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">
                      Storage Info
                    </label>
                    <input
                      type="text"
                      value={skuStorageInfo}
                      onChange={(e) => setSkuStorageInfo(e.target.value)}
                      placeholder="Store below 25°C away from moisture"
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">
                      Product Picture URL
                    </label>
                    <div className="mt-1 flex items-center gap-2">
                      {skuImageUrl && (
                        <img
                          src={skuImageUrl}
                          alt="Preview"
                          className="h-8 w-8 rounded border border-slate-200 bg-white object-contain shrink-0"
                        />
                      )}
                      <input
                        type="text"
                        value={skuImageUrl}
                        onChange={(e) => setSkuImageUrl(e.target.value)}
                        placeholder="/drug-images/... or https://..."
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus:border-orange-500 focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">
                      Selling Price (GH₵)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="1"
                      value={skuUnitDollars}
                      onChange={(e) => setSkuUnitDollars(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">Cost (GH₵)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0.5"
                      value={skuCostDollars}
                      onChange={(e) => setSkuCostDollars(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">
                      Starting Stock
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={skuStock}
                      onChange={(e) => setSkuStock(Number(e.target.value) || 0)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">Alert At</label>
                    <input
                      type="number"
                      min={1}
                      value={skuThreshold}
                      onChange={(e) => setSkuThreshold(Number(e.target.value) || 1)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">Reorder Qty</label>
                    <input
                      type="number"
                      min={5}
                      value={skuReorderQty}
                      onChange={(e) => setSkuReorderQty(Number(e.target.value) || 30)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">Expiry</label>
                    <input
                      type="date"
                      value={skuExpiry}
                      onChange={(e) => setSkuExpiry(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 font-mono text-xs focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">
                      Batch / Lot # (optional)
                    </label>
                    <input
                      type="text"
                      value={skuLot}
                      onChange={(e) => setSkuLot(e.target.value)}
                      placeholder="Auto-generated if left blank"
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">
                      Official Source URL (optional)
                    </label>
                    <input
                      type="text"
                      value={skuOfficialSourceUrl}
                      onChange={(e) => setSkuOfficialSourceUrl(e.target.value)}
                      placeholder="https://dailymed.nlm.nih.gov/..."
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setDrawer(null)}
                    className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-600"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={skuBusy}
                    className="rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
                  >
                    {skuBusy ? 'Adding...' : 'Add Item'}
                  </button>
                </div>
              </form>
            )}

            {drawer === 'new_service' && (
              <form onSubmit={handleCreateService} className="mt-4 space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Test / Service Name
                  </label>
                  <input
                    type="text"
                    required
                    value={srvName}
                    onChange={(e) => setSrvName(e.target.value)}
                    placeholder="e.g. Hepatitis B Rapid Screening"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">Type</label>
                    <select
                      value={srvCategory}
                      onChange={(e) => setSrvCategory(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs focus:border-orange-500 focus:outline-none"
                    >
                      <option value="Vital Signs">Vital Signs</option>
                      <option value="Rapid Screening">Rapid Screening</option>
                      <option value="Wellness Check">Wellness Check</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">
                      Time (mins)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={180}
                      value={srvTurnaround}
                      onChange={(e) => setSrvTurnaround(Number(e.target.value) || 10)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">Fee (GH₵)</label>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      value={srvPriceDollars}
                      onChange={(e) => setSrvPriceDollars(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    What to Expect
                  </label>
                  <input
                    type="text"
                    value={srvNotes}
                    onChange={(e) => setSrvNotes(e.target.value)}
                    placeholder="Quick counter test with pharmacist guidance."
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setDrawer(null)}
                    className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-600"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={srvBusy}
                    className="rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
                  >
                    {srvBusy ? 'Saving...' : 'Save Service'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {selectedInventoryInfo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-xs"
          onClick={() => setSelectedInventoryInfo(null)}
        >
          <div
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-4">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-orange-600">
                  {selectedInventoryInfo.manufacturerName || selectedInventoryInfo.category}
                </p>
                <h3 className="mt-0.5 font-display text-lg font-bold text-slate-900">
                  {selectedInventoryInfo.name}
                </h3>
                <p className="mt-1 font-mono text-xs text-slate-500 tabular-nums">
                  {selectedInventoryInfo.requiresPrescription ? 'Rx Only' : 'OTC'} · Sell{' '}
                  {formatMoney(selectedInventoryInfo.unitPriceCents)} · Cost{' '}
                  {formatMoney(selectedInventoryInfo.costPriceCents)} · Code{' '}
                  {selectedInventoryInfo.ndcCode}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedInventoryInfo(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close drug monograph"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-12">
              <div className="sm:col-span-4">
                <div className="aspect-square overflow-hidden rounded-xl border border-slate-200 bg-white p-3 flex items-center justify-center">
                  {selectedInventoryInfo.imageUrl ? (
                    <img
                      src={selectedInventoryInfo.imageUrl}
                      alt={selectedInventoryInfo.name}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <Pill className="h-10 w-10 text-slate-300" />
                  )}
                </div>
                <div className="mt-2.5 rounded-lg border border-slate-200 bg-slate-50 p-2.5 font-mono text-[11px] text-slate-600 space-y-1">
                  <div>Lot: {selectedInventoryInfo.lotNumber}</div>
                  <div>Exp: {selectedInventoryInfo.expiryDate}</div>
                  <div>Stock: {selectedInventoryInfo.stockQuantity} units</div>
                </div>
              </div>
              <div className="space-y-2.5 text-xs sm:col-span-8">
                {selectedInventoryInfo.activeIngredient && (
                  <div>
                    <span className="font-semibold text-slate-800">Active Ingredients: </span>
                    <span className="text-slate-600">{selectedInventoryInfo.activeIngredient}</span>
                  </div>
                )}
                {selectedInventoryInfo.dosageForm && (
                  <div>
                    <span className="font-semibold text-slate-800">Dosage Form &amp; Pack: </span>
                    <span className="text-slate-600">{selectedInventoryInfo.dosageForm}</span>
                  </div>
                )}
                {selectedInventoryInfo.description && (
                  <div>
                    <span className="font-semibold text-slate-800">Indications: </span>
                    <span className="text-slate-600">{selectedInventoryInfo.description}</span>
                  </div>
                )}
                {selectedInventoryInfo.usageDirections && (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="font-semibold text-slate-900">Dosage &amp; Directions</p>
                    <p className="mt-1 text-slate-700 leading-relaxed">
                      {selectedInventoryInfo.usageDirections}
                    </p>
                  </div>
                )}
                {selectedInventoryInfo.warnings && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50/80 p-3">
                    <p className="flex items-center gap-1 font-semibold text-amber-900">
                      <ShieldAlert className="h-3.5 w-3.5" />
                      Safety Warnings &amp; Precautions
                    </p>
                    <p className="mt-1 text-amber-950 leading-relaxed">
                      {selectedInventoryInfo.warnings}
                    </p>
                  </div>
                )}
                {selectedInventoryInfo.storageInfo && (
                  <div>
                    <span className="font-semibold text-slate-800">Storage: </span>
                    <span className="text-slate-600">{selectedInventoryInfo.storageInfo}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-5 flex items-center justify-between border-t border-slate-200 pt-3">
              {selectedInventoryInfo.officialSourceUrl ? (
                <a
                  href={selectedInventoryInfo.officialSourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-orange-700 hover:text-orange-800"
                >
                  Open Official Manufacturer / Label Page
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={() => setSelectedInventoryInfo(null)}
                className="rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  if (embedded) {
    return mainContent;
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 pb-20 md:pb-0">
      <div className="flex min-h-screen">
        {/* Clean Fixed Left Sidebar (240px) */}
        <aside className="hidden w-60 shrink-0 flex-col justify-between border-r border-slate-200 bg-white p-4 md:flex">
          <div>
            <div className="flex items-center gap-2.5 px-1">
              <NetanyaLogo size={36} />
              <div className="min-w-0">
                <p className="font-display text-xs font-bold text-slate-900 leading-tight">
                  NETANYA PHARMACY
                </p>
                <p className="mt-0.5 truncate text-[11px] text-slate-500">{user.displayName}</p>
              </div>
            </div>

            <nav className="mt-6 space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                const count =
                  item.id === 'inventory'
                    ? lowStockItems.length
                    : item.id === 'rx'
                      ? rxCounts.toCheck + rxCounts.hold
                      : 0;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveTab(item.id)}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-xs font-semibold transition-colors ${
                      active
                        ? 'bg-orange-50 text-orange-700'
                        : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                    }`}
                  >
                    <span className="flex items-center gap-2.5">
                      <Icon className={`h-4 w-4 ${active ? 'text-orange-600' : 'text-slate-400'}`} />
                      {item.label}
                    </span>
                    {count > 0 && (
                      <span
                        className={`font-mono text-[11px] font-bold tabular-nums ${
                          item.id === 'inventory' ? 'text-red-600' : 'text-orange-600'
                        }`}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="space-y-1.5 border-t border-slate-200 pt-3">
            <button
              type="button"
              onClick={onGoToStorefront}
              className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:border-orange-400"
            >
              <ShoppingBag className="h-3.5 w-3.5 text-orange-600" />
              Online Shop
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign Out
            </button>
          </div>
        </aside>

        {/* Main Viewport */}
        <div className="flex-1 min-w-0">
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6">
            <div className="flex items-center gap-2 min-w-0 text-sm">
              <Stethoscope className="h-4 w-4 shrink-0 text-orange-600" />
              <span className="truncate font-display font-bold text-slate-900">
                {navItems.find((n) => n.id === activeTab)?.label}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {activeTab !== 'pos' && (
                <button
                  type="button"
                  onClick={() => setActiveTab('pos')}
                  className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-orange-500 whitespace-nowrap"
                >
                  <Receipt className="h-3.5 w-3.5 text-orange-600" />
                  Walk-In Counter
                </button>
              )}
              <PWAInstallButton variant="compact" />
              <button
                type="button"
                onClick={onLogout}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 md:hidden"
              >
                Sign Out
              </button>
            </div>
          </header>

          <main>{mainContent}</main>
        </div>
      </div>

      {/* Mobile Bottom Navigation */}
      <nav
        aria-label="Mobile Staff Navigation"
        className="fixed bottom-0 left-0 right-0 z-40 grid h-16 grid-cols-6 border-t border-slate-200 bg-white/95 backdrop-blur-md pb-safe md:hidden"
      >
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`flex min-h-[44px] flex-col items-center justify-center gap-1 ${
                active ? 'text-orange-600' : 'text-slate-500'
              }`}
            >
              <Icon className="h-5 w-5" />
              <span className="text-[10px] font-semibold tracking-tight truncate max-w-[68px]">
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
};
