import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  BellOff,
  BellRing,
  CheckCircle2,
  ClipboardList,
  Download,
  HeartPulse,
  LogOut,
  MessageSquare,
  Pill,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  Trash2,
} from 'lucide-react';
import type {
  AuthUser,
  CarePlan,
  InsuranceClaim,
  MedicationReminder,
  OtcOrder,
  PatientPHI,
  Prescription,
} from '../types.ts';
import { apiFetch, formatMoney, formatShortDate, useRealtimeTopics } from '../utils/api.ts';
import {
  dispatchPharmacyPushAlert,
  getPushPermissionState,
  type PushPermissionState,
  requestPushPermission,
} from '../utils/notifications.ts';
import { ConsultationChat } from './ConsultationChat.tsx';
import { NetanyaLogo } from './NetanyaLogo.tsx';
import { PWAInstallButton } from './PWAControls.tsx';

interface PatientPortalProps {
  user: AuthUser;
  token: string;
  onGoToStorefront: () => void;
  onLogout: () => void;
}

type PatientTab = 'prescriptions' | 'reminders' | 'consult' | 'privacy';

const OFFLINE_REMINDERS_KEY = 'netanya_offline_reminders';

export const PatientPortal: React.FC<PatientPortalProps> = ({
  user,
  token,
  onGoToStorefront,
  onLogout,
}) => {
  const [activeTab, setActiveTab] = useState<PatientTab>('prescriptions');
  const [loading, setLoading] = useState(true);
  const [phi, setPhi] = useState<PatientPHI | null>(null);
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [carePlans, setCarePlans] = useState<CarePlan[]>([]);
  const [reminders, setReminders] = useState<MedicationReminder[]>([]);
  const [claims, setClaims] = useState<InsuranceClaim[]>([]);
  const [orders, setOrders] = useState<OtcOrder[]>([]);
  const [pushState, setPushState] = useState<PushPermissionState>(getPushPermissionState());
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [marketingOptIn, setMarketingOptIn] = useState(user.marketingOptIn);
  const [confirmingErasure, setConfirmingErasure] = useState(false);
  const [rxFilter, setRxFilter] = useState<'ALL' | 'ready' | 'dispensed' | 'pending'>('ALL');

  // Add reminder form
  const [remMedName, setRemMedName] = useState('');
  const [remDosage, setRemDosage] = useState('1 tablet');
  const [remTime, setRemTime] = useState('09:00');
  const [remBusy, setRemBusy] = useState(false);

  // Editable PHI profile form
  const [editingProfile, setEditingProfile] = useState(false);
  const [phoneDraft, setPhoneDraft] = useState('');
  const [addressDraft, setAddressDraft] = useState('');
  const [allergiesDraft, setAllergiesDraft] = useState('');
  const [insuranceDraft, setInsuranceDraft] = useState('');
  const [memberIdDraft, setMemberIdDraft] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);

  const firedDoseAlertsRef = useRef<Set<string>>(new Set());

  const loadDashboard = useCallback(async () => {
    try {
      const data = await apiFetch<{
        phi: PatientPHI | null;
        prescriptions: Prescription[];
        carePlans: CarePlan[];
        reminders: MedicationReminder[];
        claims: InsuranceClaim[];
        orders: OtcOrder[];
      }>('/api/patient/dashboard');
      setPhi(data.phi);
      if (data.phi) {
        setPhoneDraft(data.phi.phone);
        setAddressDraft(data.phi.address);
        setAllergiesDraft(data.phi.allergies.join(', '));
        setInsuranceDraft(data.phi.insuranceProvider);
        setMemberIdDraft(data.phi.memberId);
      }
      setPrescriptions(data.prescriptions);
      setCarePlans(data.carePlans);
      setReminders(data.reminders);
      setClaims(data.claims);
      setOrders(data.orders);
      try {
        localStorage.setItem(OFFLINE_REMINDERS_KEY, JSON.stringify(data.reminders));
      } catch {
        // Ignore storage error
      }
    } catch {
      try {
        const cached = localStorage.getItem(OFFLINE_REMINDERS_KEY);
        if (cached) setReminders(JSON.parse(cached) as MedicationReminder[]);
      } catch {
        // Ignore
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  useRealtimeTopics(['prescriptions', 'claims', 'inventory'], loadDashboard, token);

  const refillDuePrescriptions = useMemo(() => {
    const fiveDaysFromNow = Date.now() + 5 * 86400000;
    return prescriptions.filter(
      (rx) =>
        rx.status === 'dispensed' &&
        rx.refillsRemaining > 0 &&
        new Date(rx.nextRefillEligibleAt).getTime() <= fiveDaysFromNow
    );
  }, [prescriptions]);

  const filteredPrescriptions = useMemo(() => {
    return prescriptions.filter((rx) => {
      if (rxFilter === 'ALL') return true;
      if (rxFilter === 'pending') {
        return rx.status === 'submitted' || rx.status === 'verifying' || rx.status === 'insurance_hold';
      }
      return rx.status === rxFilter;
    });
  }, [prescriptions, rxFilter]);

  // Automated refill notification
  useEffect(() => {
    if (pushState === 'granted' && refillDuePrescriptions.length > 0) {
      const rx = refillDuePrescriptions[0];
      dispatchPharmacyPushAlert(
        'Refill Reminder · Netanya Pharmacy',
        `${rx.medicationName} (${rx.rxNumber}) is eligible for automated refill.`,
        `refill-${rx.id}`
      );
    }
  }, [pushState, refillDuePrescriptions]);

  // Real-time daily medication intake scheduler
  useEffect(() => {
    if (pushState !== 'granted' || reminders.length === 0) return;
    const checkSchedule = () => {
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const today = now.toISOString().slice(0, 10);
      for (const rem of reminders) {
        if (!rem.pushEnabled || rem.lastTakenDate === today) continue;
        const key = `${rem.id}:${today}:${hhmm}`;
        if (rem.timeOfDay === hhmm && !firedDoseAlertsRef.current.has(key)) {
          firedDoseAlertsRef.current.add(key);
          dispatchPharmacyPushAlert(
            `Dose Time: ${rem.medicationName}`,
            `${rem.dosageLabel} scheduled for ${rem.timeOfDay}.`,
            key
          );
        }
      }
    };
    checkSchedule();
    const timer = window.setInterval(checkSchedule, 30000);
    return () => window.clearInterval(timer);
  }, [pushState, reminders]);

  const handleEnablePush = async () => {
    const res = await requestPushPermission();
    setPushState(res);
    if (res === 'granted') {
      await dispatchPharmacyPushAlert(
        'Notifications Enabled · NetanyaRx',
        'You will receive daily medication intake reminders and automated refill alerts.'
      );
      setBannerMessage('Push alerts activated for medication doses and refill eligibility.');
    } else {
      setBannerMessage('Browser notification permission was not granted.');
    }
  };

  const handleSendTestAlert = async () => {
    if (pushState !== 'granted') {
      await handleEnablePush();
      return;
    }
    const nextDose = reminders[0];
    await dispatchPharmacyPushAlert(
      'Medication Intake Reminder',
      nextDose
        ? `Time for ${nextDose.medicationName} (${nextDose.dosageLabel})`
        : 'Time to take your scheduled medication.',
      'test-dose-alert'
    );
    setBannerMessage('Dispatched live push notification to your device.');
  };

  const handleRequestRefill = async (rxId: string) => {
    try {
      await apiFetch('/api/patient/prescriptions/refill', {
        method: 'POST',
        body: JSON.stringify({ prescriptionId: rxId }),
      });
      setBannerMessage('Automated refill submitted to Netanya Pharmacy dispensing queue.');
      await loadDashboard();
    } catch (err) {
      setBannerMessage(err instanceof Error ? err.message : 'Unable to request refill.');
    }
  };

  const handleAddReminder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!remMedName.trim()) return;
    setRemBusy(true);
    try {
      await apiFetch('/api/patient/reminders', {
        method: 'POST',
        body: JSON.stringify({
          medicationName: remMedName.trim(),
          dosageLabel: remDosage.trim(),
          timeOfDay: remTime,
          frequency: 'Daily',
          pushEnabled: true,
        }),
      });
      setRemMedName('');
      await loadDashboard();
    } finally {
      setRemBusy(false);
    }
  };

  const handleToggleReminderPush = async (rem: MedicationReminder) => {
    await apiFetch(`/api/patient/reminders/${rem.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ pushEnabled: !rem.pushEnabled }),
    });
    await loadDashboard();
  };

  const handleMarkTaken = async (id: string) => {
    try {
      await apiFetch(`/api/patient/reminders/${id}/take`, { method: 'PATCH' });
      await loadDashboard();
    } catch (err) {
      setBannerMessage(err instanceof Error ? err.message : 'Unable to save dose status.');
    }
  };

  const handleDeleteReminder = async (id: string) => {
    await apiFetch(`/api/patient/reminders/${id}`, { method: 'DELETE' });
    await loadDashboard();
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileSaving(true);
    try {
      const res = await apiFetch<{ phi: PatientPHI }>('/api/patient/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          phone: phoneDraft,
          address: addressDraft,
          allergies: allergiesDraft
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          insuranceProvider: insuranceDraft,
          memberId: memberIdDraft,
        }),
      });
      setPhi(res.phi);
      setEditingProfile(false);
      setBannerMessage('Encrypted health profile and insurance details updated.');
    } finally {
      setProfileSaving(false);
    }
  };

  const handleConsentToggle = async (nextVal: boolean) => {
    setMarketingOptIn(nextVal);
    await apiFetch('/api/patient/privacy/consent', {
      method: 'PATCH',
      body: JSON.stringify({ marketingOptIn: nextVal }),
    });
    setBannerMessage('GDPR communication preferences updated.');
  };

  const handleExportArchive = async () => {
    const archive = await apiFetch<Record<string, unknown>>('/api/patient/privacy/export');
    const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `netanya-patient-archive-${user.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setBannerMessage('Downloaded encrypted-origin GDPR Article 20 JSON archive.');
  };

  const handleErasureRequest = async () => {
    const res = await apiFetch<{ message: string; erased?: boolean }>('/api/patient/privacy/erasure', {
      method: 'POST',
    });
    setConfirmingErasure(false);
    setBannerMessage(res.message);
    if (res.erased) {
      await loadDashboard();
    }
  };

  const todayDate = new Date().toISOString().slice(0, 10);

  const navItems: Array<{ id: PatientTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'prescriptions', label: 'Rx & Care', icon: Pill },
    { id: 'reminders', label: 'Reminders', icon: Bell },
    { id: 'consult', label: 'Pharmacist Chat', icon: MessageSquare },
    { id: 'privacy', label: 'Privacy', icon: ShieldCheck },
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 pb-20 md:pb-0">
      <div className="flex min-h-screen">
        {/* Desktop Sidebar */}
        <aside className="hidden w-64 shrink-0 flex-col justify-between border-r border-slate-200 bg-white p-5 md:flex">
          <div>
            <div className="flex items-center gap-2.5">
              <NetanyaLogo size={36} />
              <div className="min-w-0">
                <p className="font-display text-xs font-bold text-slate-900 leading-tight">
                  NETANYA PHARMACY
                </p>
                <p className="mt-0.5 truncate text-[11px] text-slate-500">
                  {user.displayName}
                </p>
              </div>
            </div>

            <nav className="mt-6 space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveTab(item.id)}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${
                      active
                        ? 'bg-orange-50 text-orange-700'
                        : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                    }`}
                  >
                    <Icon className={`h-4 w-4 ${active ? 'text-orange-600' : 'text-slate-400'}`} />
                    {item.label}
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="space-y-2 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={onGoToStorefront}
              className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:border-orange-400 hover:text-orange-700"
            >
              <ShoppingBag className="h-3.5 w-3.5 text-orange-600" />
              Retail OTC Shop
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

        {/* Main Content Area */}
        <div className="flex-1">
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6">
            <div className="flex items-center gap-3 min-w-0">
              <span className="truncate font-display text-sm font-bold text-slate-900 md:text-base">
                {navItems.find((n) => n.id === activeTab)?.label}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <PWAInstallButton variant="compact" />
              <button
                type="button"
                onClick={onGoToStorefront}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-orange-400 md:hidden"
              >
                Shop
              </button>
              <button
                type="button"
                onClick={onLogout}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 md:hidden"
              >
                Exit
              </button>
            </div>
          </header>

          <main className="mx-auto max-w-5xl p-4 sm:p-6 space-y-6">
            {bannerMessage && (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-xs font-medium text-orange-900">
                <span>{bannerMessage}</span>
                <button
                  type="button"
                  onClick={() => setBannerMessage(null)}
                  className="font-semibold text-orange-700 hover:underline"
                >
                  Dismiss
                </button>
              </div>
            )}

            {refillDuePrescriptions.length > 0 && (
              <div className="flex flex-col justify-between gap-3 rounded-xl border border-orange-300 bg-white p-4 sm:flex-row sm:items-center">
                <div className="flex items-start gap-3">
                  <BellRing className="mt-0.5 h-5 w-5 shrink-0 text-orange-600" />
                  <div>
                    <p className="text-sm font-bold text-slate-900">
                      Automated Refill Eligible: {refillDuePrescriptions[0].medicationName}
                    </p>
                    <p className="text-xs text-slate-600">
                      {refillDuePrescriptions[0].rxNumber} · Eligible{' '}
                      {formatShortDate(refillDuePrescriptions[0].nextRefillEligibleAt)} ·{' '}
                      {refillDuePrescriptions[0].refillsRemaining} refills remaining
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleRequestRefill(refillDuePrescriptions[0].id)}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700 shrink-0 min-h-[40px]"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Request Auto-Refill
                </button>
              </div>
            )}

            {loading ? (
              <div className="space-y-4">
                <div className="h-32 animate-pulse rounded-xl border border-slate-200 bg-white" />
                <div className="h-48 animate-pulse rounded-xl border border-slate-200 bg-white" />
              </div>
            ) : activeTab === 'prescriptions' ? (
              <div className="space-y-6">
                <section className="rounded-xl border border-slate-200 bg-white">
                  <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <h2 className="font-display text-base font-bold text-slate-900">
                      My Prescriptions
                    </h2>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
                        {(['ALL', 'ready', 'dispensed', 'pending'] as const).map((f) => (
                          <button
                            key={f}
                            type="button"
                            onClick={() => setRxFilter(f)}
                            className={`rounded-md px-2.5 py-1 text-xs font-semibold capitalize transition-colors ${
                              rxFilter === f
                                ? 'bg-white text-slate-900 shadow-xs'
                                : 'text-slate-600 hover:text-slate-900'
                            }`}
                          >
                            {f === 'ALL' ? 'All' : f}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={onGoToStorefront}
                        className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-semibold text-orange-700 hover:bg-orange-100"
                      >
                        Buy OTC Items
                      </button>
                    </div>
                  </div>

                  <div className="divide-y divide-slate-100">
                    {filteredPrescriptions.length === 0 ? (
                      <div className="p-8 text-center text-xs text-slate-500">
                        No prescriptions match this filter.
                      </div>
                    ) : (
                      filteredPrescriptions.map((rx) => {
                        const claim = claims.find((c) => c.prescriptionId === rx.id);
                        return (
                          <div
                            key={rx.id}
                            className="flex flex-col justify-between gap-4 p-5 sm:flex-row sm:items-center"
                          >
                            <div className="space-y-1">
                              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                                <span className="font-mono font-semibold text-slate-700 tabular-nums">
                                  {rx.rxNumber}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono tabular-nums">NDC {rx.ndcCode}</span>
                                <span aria-hidden="true">·</span>
                                <span
                                  className={`font-semibold uppercase tracking-wide ${
                                    rx.status === 'ready' || rx.status === 'dispensed'
                                      ? 'text-emerald-700'
                                      : rx.status === 'insurance_hold'
                                        ? 'text-red-600'
                                        : 'text-orange-600'
                                  }`}
                                >
                                  {rx.status === 'ready'
                                    ? 'Ready for Pickup'
                                    : rx.status === 'dispensed'
                                      ? 'Collected'
                                      : rx.status === 'insurance_hold'
                                        ? 'Insurance Hold'
                                        : 'Checking'}
                                </span>
                              </div>
                              <h3 className="font-display text-base font-bold text-slate-900">
                                {rx.medicationName}
                              </h3>
                              <p className="text-xs text-slate-600">{rx.dosageInstructions}</p>
                              <p className="text-xs text-slate-500">
                                Prescriber: {rx.prescriberName} · Qty {rx.quantity} ({rx.daysSupply}{' '}
                                days) · {rx.refillsRemaining} refills left
                              </p>
                              {claim && (
                                <p className="font-mono text-xs text-slate-600 tabular-nums">
                                  Insurance ({claim.payerName}): Insurer paid{' '}
                                  {formatMoney(claim.insurerPaidCents)} · Your copay{' '}
                                  {formatMoney(claim.patientCopayCents)}
                                </p>
                              )}
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              {rx.status === 'dispensed' && rx.refillsRemaining > 0 && (
                                <button
                                  type="button"
                                  onClick={() => handleRequestRefill(rx.id)}
                                  className="rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700 min-h-[40px]"
                                >
                                  Refill Now
                                </button>
                              )}
                              {rx.status === 'ready' && (
                                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                                  <CheckCircle2 className="h-4 w-4" />
                                  Ready at Counter
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </section>

                {/* Clinical Care Plans */}
                <section className="rounded-xl border border-slate-200 bg-white p-5">
                  <div className="flex items-center gap-2">
                    <HeartPulse className="h-5 w-5 text-orange-600" />
                    <h2 className="font-display text-base font-bold text-slate-900">
                      Pharmacist Care Plans
                    </h2>
                  </div>
                  <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                    {carePlans.length === 0 ? (
                      <p className="text-xs text-slate-500">No active care plans documented yet.</p>
                    ) : (
                      carePlans.map((cp) => (
                        <div
                          key={cp.id}
                          className="rounded-lg border border-slate-200 bg-slate-50/70 p-4 space-y-2"
                        >
                          <div className="flex items-center justify-between">
                            <h3 className="text-sm font-bold text-slate-900">{cp.conditionFocus}</h3>
                            <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                              Follow-up {cp.followUpDate}
                            </span>
                          </div>
                          <p className="text-xs text-slate-700">{cp.clinicalGoals}</p>
                          <p className="text-xs font-medium text-amber-800">
                            Interaction Note: {cp.interactionWarnings}
                          </p>
                          <p className="text-[11px] text-slate-500">
                            Updated by {cp.pharmacistName}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                </section>

                {/* Retail OTC Orders */}
                {orders.length > 0 && (
                  <section className="rounded-xl border border-slate-200 bg-white p-5">
                    <div className="flex items-center gap-2">
                      <ClipboardList className="h-5 w-5 text-orange-600" />
                      <h2 className="font-display text-base font-bold text-slate-900">
                        Recent Retail &amp; OTC Orders
                      </h2>
                    </div>
                    <div className="mt-3 divide-y divide-slate-100">
                      {orders.map((ord) => (
                        <div key={ord.id} className="flex items-center justify-between py-3 text-xs">
                          <div>
                            <span className="font-mono font-bold text-slate-900 tabular-nums">
                              {ord.orderNumber}
                            </span>
                            <span className="mx-2 text-slate-400">·</span>
                            <span className="text-slate-600">
                              {ord.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}
                            </span>
                            <span className="ml-2 font-semibold uppercase text-orange-600">
                              ({ord.status.replace(/_/g, ' ')})
                            </span>
                          </div>
                          <span className="font-mono font-bold text-slate-900 tabular-nums">
                            {formatMoney(ord.totalCents)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            ) : activeTab === 'reminders' ? (
              <div className="space-y-6">
                <section className="flex flex-col justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-center">
                  <div>
                    <h2 className="font-display text-base font-bold text-slate-900">
                      Dose &amp; Refill Notifications
                    </h2>
                    <p className="mt-1 text-xs text-slate-600">
                      Status: <strong className="uppercase">{pushState}</strong>
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {pushState !== 'granted' && (
                      <button
                        type="button"
                        onClick={handleEnablePush}
                        className="rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700 min-h-[42px]"
                      >
                        Enable Push Alerts
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleSendTestAlert}
                      className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:border-orange-500 min-h-[42px]"
                    >
                      Trigger Dose Alert Now
                    </button>
                  </div>
                </section>

                <section className="rounded-xl border border-slate-200 bg-white p-5">
                  <h2 className="font-display text-base font-bold text-slate-900">
                    Daily Medication Intake Schedule
                  </h2>
                  <div className="mt-4 divide-y divide-slate-100">
                    {reminders.map((rem) => {
                      const takenToday = rem.lastTakenDate === todayDate;
                      return (
                        <div
                          key={rem.id}
                          className="flex flex-col justify-between gap-3 py-4 sm:flex-row sm:items-center"
                        >
                          <div className="flex items-center gap-4">
                            <div className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 font-mono text-sm font-bold text-orange-700 tabular-nums">
                              {rem.timeOfDay}
                            </div>
                            <div>
                              <p className="text-sm font-bold text-slate-900">
                                {rem.medicationName}
                              </p>
                              <p className="text-xs text-slate-600">
                                {rem.dosageLabel} · {rem.frequency} ·{' '}
                                <span className="font-mono tabular-nums">
                                  {rem.adherenceStreak}-day streak
                                </span>
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleToggleReminderPush(rem)}
                              className={`inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-xs font-semibold min-h-[40px] ${
                                rem.pushEnabled
                                  ? 'border-orange-200 bg-orange-50 text-orange-700'
                                  : 'border-slate-200 bg-white text-slate-500'
                              }`}
                              title="Toggle push alert for this medication"
                            >
                              {rem.pushEnabled ? (
                                <>
                                  <Bell className="h-3.5 w-3.5" />
                                  Alert On
                                </>
                              ) : (
                                <>
                                  <BellOff className="h-3.5 w-3.5" />
                                  Muted
                                </>
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleMarkTaken(rem.id)}
                              className={`rounded-lg px-4 py-2 text-xs font-semibold transition-colors min-h-[40px] ${
                                takenToday
                                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                  : 'bg-orange-600 text-white hover:bg-orange-700'
                              }`}
                            >
                              {takenToday ? 'Taken Today' : 'Mark Taken'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteReminder(rem.id)}
                              className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-slate-400 hover:text-red-600"
                              aria-label={`Remove ${rem.medicationName} reminder`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <form
                    onSubmit={handleAddReminder}
                    className="mt-5 grid grid-cols-1 gap-3 border-t border-slate-200 pt-5 sm:grid-cols-4"
                  >
                    <input
                      type="text"
                      required
                      value={remMedName}
                      onChange={(e) => setRemMedName(e.target.value)}
                      placeholder="Medication name"
                      className="rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                    />
                    <input
                      type="text"
                      value={remDosage}
                      onChange={(e) => setRemDosage(e.target.value)}
                      placeholder="Dosage (e.g., 1 tablet)"
                      className="rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                    />
                    <input
                      type="time"
                      required
                      value={remTime}
                      onChange={(e) => setRemTime(e.target.value)}
                      className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono focus:border-orange-500 focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={remBusy}
                      className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 min-h-[40px]"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add Dose Reminder
                    </button>
                  </form>
                </section>
              </div>
            ) : activeTab === 'consult' ? (
              <ConsultationChat user={user} token={token} />
            ) : (
              /* HIPAA & GDPR Privacy Center + Editable Health Profile */
              <div className="space-y-6">
                <section className="rounded-xl border border-slate-200 bg-white p-6">
                  <div className="flex items-start justify-between gap-4">
                    <h2 className="font-display text-base font-bold text-slate-900">
                      My Health Details
                    </h2>
                    <button
                      type="button"
                      onClick={() => setEditingProfile((v) => !v)}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-orange-500 shrink-0"
                    >
                      {editingProfile ? 'Cancel' : 'Edit Profile'}
                    </button>
                  </div>

                  {phi && !editingProfile ? (
                    <div className="mt-5 grid grid-cols-1 gap-4 border-t border-slate-100 pt-5 text-xs sm:grid-cols-2">
                      <div>
                        <span className="text-slate-500">Date of Birth</span>
                        <p className="mt-0.5 font-mono font-semibold text-slate-900 tabular-nums">
                          {phi.dob}
                        </p>
                      </div>
                      <div>
                        <span className="text-slate-500">Phone</span>
                        <p className="mt-0.5 font-mono font-semibold text-slate-900">{phi.phone}</p>
                      </div>
                      <div>
                        <span className="text-slate-500">Primary Insurance</span>
                        <p className="mt-0.5 font-semibold text-slate-900">
                          {phi.insuranceProvider} · ID {phi.memberId}
                        </p>
                      </div>
                      <div>
                        <span className="text-slate-500">Documented Allergies</span>
                        <p className="mt-0.5 font-semibold text-red-700">
                          {phi.allergies.join(', ')}
                        </p>
                      </div>
                      <div className="sm:col-span-2">
                        <span className="text-slate-500">Delivery Address</span>
                        <p className="mt-0.5 font-medium text-slate-900">{phi.address}</p>
                      </div>
                    </div>
                  ) : (
                    <form
                      onSubmit={handleSaveProfile}
                      className="mt-5 grid grid-cols-1 gap-3 border-t border-slate-100 pt-5 sm:grid-cols-2"
                    >
                      <div>
                        <label className="block text-xs font-semibold text-slate-700">Phone</label>
                        <input
                          type="tel"
                          value={phoneDraft}
                          onChange={(e) => setPhoneDraft(e.target.value)}
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700">
                          Insurance Plan
                        </label>
                        <input
                          type="text"
                          value={insuranceDraft}
                          onChange={(e) => setInsuranceDraft(e.target.value)}
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700">
                          Member ID
                        </label>
                        <input
                          type="text"
                          value={memberIdDraft}
                          onChange={(e) => setMemberIdDraft(e.target.value)}
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus:border-orange-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700">
                          Drug Allergies (comma-separated)
                        </label>
                        <input
                          type="text"
                          value={allergiesDraft}
                          onChange={(e) => setAllergiesDraft(e.target.value)}
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-xs font-semibold text-slate-700">
                          Delivery Address
                        </label>
                        <input
                          type="text"
                          value={addressDraft}
                          onChange={(e) => setAddressDraft(e.target.value)}
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                        />
                      </div>
                      <div className="sm:col-span-2 flex justify-end">
                        <button
                          type="submit"
                          disabled={profileSaving}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700"
                        >
                          <Save className="h-3.5 w-3.5" />
                          {profileSaving ? 'Encrypting & Saving...' : 'Save Encrypted Profile'}
                        </button>
                      </div>
                    </form>
                  )}
                </section>

                <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
                  <h2 className="font-display text-base font-bold text-slate-900">
                    Privacy &amp; Data
                  </h2>

                  <label className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 p-4">
                    <span className="text-sm font-semibold text-slate-900">
                      Health &amp; Wellness Updates
                    </span>
                    <input
                      type="checkbox"
                      checked={marketingOptIn}
                      onChange={(e) => handleConsentToggle(e.target.checked)}
                      className="h-5 w-5 rounded border-slate-300 text-orange-600 focus:ring-orange-500"
                    />
                  </label>

                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={handleExportArchive}
                      className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-orange-700 min-h-[42px]"
                    >
                      <Download className="h-4 w-4" />
                      Download My Health Data Archive (JSON)
                    </button>
                    {!confirmingErasure ? (
                      <button
                        type="button"
                        onClick={() => setConfirmingErasure(true)}
                        className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-xs font-semibold text-red-700 hover:bg-red-100 min-h-[42px]"
                      >
                        <ShieldAlert className="h-4 w-4" />
                        Erase Non-Statutory Personal Data
                      </button>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2">
                        <span className="text-xs font-semibold text-red-900">
                          Purges reminders, chats &amp; contact info permanently:
                        </span>
                        <button
                          type="button"
                          onClick={handleErasureRequest}
                          className="rounded-md bg-red-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-800"
                        >
                          Confirm Erasure
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingErasure(false)}
                          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                </section>
              </div>
            )}
          </main>
        </div>
      </div>

      {/* Mobile Bottom Thumb-Zone Navigation */}
      <nav
        aria-label="Mobile Patient Navigation"
        className="fixed bottom-0 left-0 right-0 z-40 grid h-16 grid-cols-4 border-t border-slate-200 bg-white/95 backdrop-blur-md pb-safe md:hidden"
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
              <span className="text-[10px] font-semibold tracking-tight">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
};
