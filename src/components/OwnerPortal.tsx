import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  ClipboardCheck,
  Download,
  LogOut,
  Search,
  Settings2,
  ShieldCheck,
  ShoppingBag,
  TrendingUp,
  UserPlus,
  Users,
} from 'lucide-react';
import type { AuthUser, InsurancePlan, OwnerAnalytics, UserRole } from '../types.ts';
import { apiFetch, formatMoney, useRealtimeTopics } from '../utils/api.ts';
import { NetanyaLogo } from './NetanyaLogo.tsx';
import { PWAInstallButton } from './PWAControls.tsx';
import { StaffPortal } from './StaffPortal.tsx';

interface OwnerPortalProps {
  user: AuthUser;
  token: string;
  onGoToStorefront: () => void;
  onLogout: () => void;
}

type OwnerTab = 'analytics' | 'governance' | 'clinical';

interface GovernanceUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  consentAcceptedAt: string | null;
  createdAt: string;
}

export const OwnerPortal: React.FC<OwnerPortalProps> = ({
  user,
  token,
  onGoToStorefront,
  onLogout,
}) => {
  const [activeTab, setActiveTab] = useState<OwnerTab>('analytics');
  const [analytics, setAnalytics] = useState<OwnerAnalytics | null>(null);
  const [govUsers, setGovUsers] = useState<GovernanceUser[]>([]);
  const [plans, setPlans] = useState<InsurancePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoveredDayIdx, setHoveredDayIdx] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Audit Log filters
  const [auditSearch, setAuditSearch] = useState('');
  const [auditActionFilter, setAuditActionFilter] = useState('ALL');

  // Provision User form
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('pharmacist');
  const [provisionBusy, setProvisionBusy] = useState(false);

  // Editable payer contract drafts
  const [planDrafts, setPlanDrafts] = useState<
    Record<
      string,
      {
        tier1Dollars: string;
        tier2Dollars: string;
        tier3Dollars: string;
        reimbursementPct: string;
      }
    >
  >({});

  const loadAnalytics = useCallback(async () => {
    try {
      const data = await apiFetch<OwnerAnalytics>('/api/owner/analytics');
      setAnalytics(data);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadGovernance = useCallback(async () => {
    try {
      const data = await apiFetch<{
        users: GovernanceUser[];
        insurancePlans: InsurancePlan[];
      }>('/api/owner/governance');
      setGovUsers(data.users);
      setPlans(data.insurancePlans);

      const drafts: Record<
        string,
        {
          tier1Dollars: string;
          tier2Dollars: string;
          tier3Dollars: string;
          reimbursementPct: string;
        }
      > = {};
      for (const p of data.insurancePlans) {
        drafts[p.id] = {
          tier1Dollars: (p.tier1CopayCents / 100).toFixed(2),
          tier2Dollars: (p.tier2CopayCents / 100).toFixed(2),
          tier3Dollars: (p.tier3CopayCents / 100).toFixed(2),
          reimbursementPct: String(Math.round(p.reimbursementRate * 100)),
        };
      }
      setPlanDrafts(drafts);
    } catch {
      // Handled when tab opened
    }
  }, []);

  const loadAllOwnerData = useCallback(async () => {
    await Promise.all([loadAnalytics(), loadGovernance()]);
  }, [loadAnalytics, loadGovernance]);

  useEffect(() => {
    loadAllOwnerData();
  }, [loadAllOwnerData]);

  useRealtimeTopics(
    ['analytics', 'prescriptions', 'claims', 'inventory', 'replenishments', 'audit'],
    loadAllOwnerData,
    token
  );

  const distinctAuditActions = useMemo(() => {
    if (!analytics) return [];
    return Array.from(new Set(analytics.auditLogs.map((l) => l.action))).sort();
  }, [analytics]);

  const filteredAuditLogs = useMemo(() => {
    if (!analytics) return [];
    const q = auditSearch.trim().toLowerCase();
    return analytics.auditLogs.filter((log) => {
      if (auditActionFilter !== 'ALL' && log.action !== auditActionFilter) return false;
      if (!q) return true;
      return (
        log.actorName.toLowerCase().includes(q) ||
        log.action.toLowerCase().includes(q) ||
        log.summary.toLowerCase().includes(q) ||
        log.actorRole.toLowerCase().includes(q)
      );
    });
  }, [analytics, auditSearch, auditActionFilter]);

  const handleDownloadAuditCsv = () => {
    const headers = ['Timestamp', 'Actor', 'Role', 'Action', 'Resource Type', 'Resource ID', 'Summary'];
    const rows = filteredAuditLogs.map((log) => [
      log.createdAt,
      `"${log.actorName.replace(/"/g, '""')}"`,
      log.actorRole,
      log.action,
      log.resourceType,
      log.resourceId,
      `"${log.summary.replace(/"/g, '""')}"`,
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `netanya-hipaa-gdpr-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleProvisionUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setProvisionBusy(true);
    try {
      await apiFetch('/api/owner/users', {
        method: 'POST',
        body: JSON.stringify({
          displayName: newName,
          email: newEmail,
          password: newPassword,
          role: newRole,
        }),
      });
      setToast(`Provisioned ${newRole} account for ${newName} (${newEmail}).`);
      setNewName('');
      setNewEmail('');
      setNewPassword('');
      await loadAllOwnerData();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Unable to provision account.');
    } finally {
      setProvisionBusy(false);
    }
  };

  const handleChangeUserRole = async (targetUser: GovernanceUser, nextRole: UserRole) => {
    try {
      await apiFetch(`/api/owner/users/${targetUser.id}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role: nextRole }),
      });
      setToast(`Updated RBAC role for ${targetUser.displayName} to ${nextRole}.`);
      await loadAllOwnerData();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Unable to update user role.');
    }
  };

  const handleSavePayerContract = async (plan: InsurancePlan) => {
    const d = planDrafts[plan.id];
    if (!d) return;
    try {
      await apiFetch(`/api/owner/insurance-plans/${plan.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          tier1CopayCents: Math.max(0, Math.round((Number(d.tier1Dollars) || 0) * 100)),
          tier2CopayCents: Math.max(0, Math.round((Number(d.tier2Dollars) || 0) * 100)),
          tier3CopayCents: Math.max(0, Math.round((Number(d.tier3Dollars) || 0) * 100)),
          reimbursementRate: Math.min(1, Math.max(0.5, (Number(d.reimbursementPct) || 80) / 100)),
        }),
      });
      setToast(`Saved contracted copay tiers & reimbursement rate for ${plan.payerName}.`);
      await loadAllOwnerData();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Failed to update payer contract.');
    }
  };

  const maxTrendRevenue = analytics
    ? Math.max(
        10000,
        ...analytics.dailyTrends.map((d) => d.rxRevenueCents + d.otcRevenueCents)
      )
    : 10000;

  return (
    <div className="min-h-screen animate-fade-in bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2.5 min-w-0">
            <NetanyaLogo size={40} className="h-10 w-10" />
            <div className="min-w-0">
              <span className="block truncate font-display text-base font-bold text-slate-900">
                NETANYA PHARMACY
              </span>
              <span className="block truncate text-[11px] text-slate-500">
                {user.displayName}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <PWAInstallButton variant="compact" />
            <button
              type="button"
              onClick={onGoToStorefront}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-orange-400"
            >
              <ShoppingBag className="h-3.5 w-3.5 text-orange-600" />
              Storefront
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign Out
            </button>
          </div>
        </div>

        {/* Sub-view navigation bar */}
        <div className="border-t border-slate-200 bg-slate-50/70">
          <div className="mx-auto flex max-w-7xl gap-2 overflow-x-auto px-4 py-2 sm:px-6 lg:px-8">
            <button
              type="button"
              onClick={() => setActiveTab('analytics')}
              className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold whitespace-nowrap transition-colors ${
                activeTab === 'analytics'
                  ? 'bg-orange-600 text-white'
                  : 'bg-white text-slate-700 border border-slate-200 hover:border-orange-400'
              }`}
            >
              <TrendingUp className="h-3.5 w-3.5" />
              Sales &amp; Stock Overview
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('governance')}
              className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold whitespace-nowrap transition-colors ${
                activeTab === 'governance'
                  ? 'bg-orange-600 text-white'
                  : 'bg-white text-slate-700 border border-slate-200 hover:border-orange-400'
              }`}
            >
              <Users className="h-3.5 w-3.5" />
              Staff &amp; Insurance Rates
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('clinical')}
              className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold whitespace-nowrap transition-colors ${
                activeTab === 'clinical'
                  ? 'bg-orange-600 text-white'
                  : 'bg-white text-slate-700 border border-slate-200 hover:border-orange-400'
              }`}
            >
              <ClipboardCheck className="h-3.5 w-3.5" />
              Counter, Rx &amp; Claims
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8 space-y-6">
        {toast && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-xs font-medium text-orange-900">
            <span>{toast}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="font-semibold text-orange-700 hover:underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {activeTab === 'clinical' ? (
          <StaffPortal
            user={user}
            token={token}
            onGoToStorefront={onGoToStorefront}
            onLogout={onLogout}
            embedded
          />
        ) : activeTab === 'governance' ? (
          <div className="space-y-6">
            {/* Provision New Staff / Supplier / Owner Account */}
            <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-4">
              <div className="flex items-center gap-2">
                <UserPlus className="h-4 w-4 text-orange-600" />
                <h2 className="font-display text-base font-bold text-slate-900">
                  Add Account
                </h2>
              </div>

              <form
                onSubmit={handleProvisionUser}
                className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5 items-end"
              >
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700">
                    Full Name
                  </label>
                  <input
                    type="text"
                    required
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Pharm. Kwesi Boateng"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700">
                    Work Email
                  </label>
                  <input
                    type="email"
                    required
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="kwesi@netanyarx.com"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700">
                    Initial Password (8+ chars)
                  </label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Min 8 characters"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700">
                    Role
                  </label>
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as UserRole)}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
                  >
                    <option value="pharmacist">Pharmacist / Staff</option>
                    <option value="supplier">Supplier Partner</option>
                    <option value="owner">Owner</option>
                    <option value="patient">Customer / Patient</option>
                  </select>
                </div>
                <button
                  type="submit"
                  disabled={provisionBusy}
                  className="rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700 disabled:opacity-50 min-h-[38px]"
                >
                  {provisionBusy ? 'Saving...' : 'Create Account'}
                </button>
              </form>
            </section>

            {/* User Directory */}
            <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="border-b border-slate-200 px-5 py-4">
                <h2 className="font-display text-sm font-bold text-slate-900">
                  Accounts &amp; Roles
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 font-semibold">User</th>
                      <th className="px-4 py-3 font-semibold">Email</th>
                      <th className="px-4 py-3 font-semibold">Privacy Consent</th>
                      <th className="px-4 py-3 font-semibold">Created</th>
                      <th className="px-4 py-3 font-semibold text-right">Assigned Role</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {govUsers.map((u) => {
                      const isSelf = u.id === user.id;
                      return (
                        <tr key={u.id} className="hover:bg-slate-50/70">
                          <td className="px-4 py-3 font-semibold text-slate-900">
                            {u.displayName}
                            {isSelf && (
                              <span className="ml-2 font-mono text-[10px] text-orange-600">
                                (YOU)
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 font-mono text-slate-600">{u.email}</td>
                          <td className="px-4 py-3 font-mono text-[11px] text-slate-500 tabular-nums">
                            {u.consentAcceptedAt
                              ? new Date(u.consentAcceptedAt).toLocaleDateString()
                              : 'Pending'}
                          </td>
                          <td className="px-4 py-3 font-mono text-[11px] text-slate-500 tabular-nums">
                            {new Date(u.createdAt).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <select
                              value={u.role}
                              disabled={isSelf}
                              onChange={(e) => handleChangeUserRole(u, e.target.value as UserRole)}
                              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800 focus:border-orange-500 focus:outline-none disabled:opacity-60"
                            >
                              <option value="patient">patient</option>
                              <option value="pharmacist">pharmacist</option>
                              <option value="supplier">supplier</option>
                              <option value="owner">owner</option>
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Insurance Payer Contract Editor */}
            <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-4">
                <Settings2 className="h-4 w-4 text-orange-600" />
                <h2 className="font-display text-sm font-bold text-slate-900">
                  Insurance Rates &amp; Copay Tiers
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Payer / BIN · PCN</th>
                      <th className="px-4 py-3 font-semibold">Tier 1 Copay (GH₵)</th>
                      <th className="px-4 py-3 font-semibold">Tier 2 Copay (GH₵)</th>
                      <th className="px-4 py-3 font-semibold">Tier 3 Copay (GH₵)</th>
                      <th className="px-4 py-3 font-semibold">Reimbursement (%)</th>
                      <th className="px-4 py-3 font-semibold text-right">Contract</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {plans.map((plan) => {
                      const d = planDrafts[plan.id] || {
                        tier1Dollars: (plan.tier1CopayCents / 100).toFixed(2),
                        tier2Dollars: (plan.tier2CopayCents / 100).toFixed(2),
                        tier3Dollars: (plan.tier3CopayCents / 100).toFixed(2),
                        reimbursementPct: String(Math.round(plan.reimbursementRate * 100)),
                      };
                      return (
                        <tr key={plan.id} className="hover:bg-slate-50/70">
                          <td className="px-4 py-3">
                            <div className="font-semibold text-slate-900">{plan.payerName}</div>
                            <div className="font-mono text-[11px] text-slate-500 tabular-nums">
                              BIN {plan.bin} · PCN {plan.pcn} · {plan.groupPrefix}*
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <input
                              type="number"
                              step="0.50"
                              min="0"
                              value={d.tier1Dollars}
                              onChange={(e) =>
                                setPlanDrafts((prev) => ({
                                  ...prev,
                                  [plan.id]: { ...d, tier1Dollars: e.target.value },
                                }))
                              }
                              className="w-24 rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                            />
                          </td>
                          <td className="px-4 py-3">
                            <input
                              type="number"
                              step="0.50"
                              min="0"
                              value={d.tier2Dollars}
                              onChange={(e) =>
                                setPlanDrafts((prev) => ({
                                  ...prev,
                                  [plan.id]: { ...d, tier2Dollars: e.target.value },
                                }))
                              }
                              className="w-24 rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                            />
                          </td>
                          <td className="px-4 py-3">
                            <input
                              type="number"
                              step="0.50"
                              min="0"
                              value={d.tier3Dollars}
                              onChange={(e) =>
                                setPlanDrafts((prev) => ({
                                  ...prev,
                                  [plan.id]: { ...d, tier3Dollars: e.target.value },
                                }))
                              }
                              className="w-24 rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                            />
                          </td>
                          <td className="px-4 py-3">
                            <input
                              type="number"
                              min="50"
                              max="100"
                              value={d.reimbursementPct}
                              onChange={(e) =>
                                setPlanDrafts((prev) => ({
                                  ...prev,
                                  [plan.id]: { ...d, reimbursementPct: e.target.value },
                                }))
                              }
                              className="w-20 rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                            />
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              type="button"
                              onClick={() => handleSavePayerContract(plan)}
                              className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                            >
                              Save Contract
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        ) : loading || !analytics ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[1, 2, 3, 4].map((n) => (
              <div
                key={n}
                className="h-28 animate-pulse rounded-xl border border-slate-200 bg-white"
              />
            ))}
          </div>
        ) : (
          <>
            {/* KPI Row */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-white p-5">
                <p className="text-xs font-medium text-slate-500">Prescription Revenue</p>
                <p className="mt-2 font-mono text-2xl font-bold text-slate-900 tabular-nums">
                  {formatMoney(analytics.totalRxRevenueCents)}
                </p>
                <p className="mt-1 font-mono text-[11px] text-slate-500 tabular-nums">
                  Insurance {formatMoney(analytics.totalInsurerPayoutCents)} · Copays{' '}
                  {formatMoney(analytics.totalPatientCopayCents)}
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-5">
                <p className="text-xs font-medium text-slate-500">Counter &amp; Shop Sales</p>
                <p className="mt-2 font-mono text-2xl font-bold text-orange-600 tabular-nums">
                  {formatMoney(analytics.totalOtcRevenueCents)}
                </p>
                <p className="mt-1 text-[11px] text-slate-500">Walk-in &amp; online orders</p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-5">
                <p className="text-xs font-medium text-slate-500">Prescriptions</p>
                <p className="mt-2 font-mono text-2xl font-bold text-slate-900 tabular-nums">
                  {analytics.dispensedCount} / {analytics.totalPrescriptions} Handed Over
                </p>
                <p className="mt-1 font-mono text-[11px] text-slate-500 tabular-nums">
                  {analytics.adjudicatedClaimsCount} approved · {analytics.rejectedClaimsCount}{' '}
                  on hold
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-5">
                <p className="text-xs font-medium text-slate-500">Low Stock</p>
                <p
                  className={`mt-2 font-mono text-2xl font-bold tabular-nums ${
                    analytics.lowStockItemsCount > 0 ? 'text-amber-600' : 'text-emerald-700'
                  }`}
                >
                  {analytics.lowStockItemsCount} Items Low
                </p>
                <p className="mt-1 font-mono text-[11px] text-slate-500 tabular-nums">
                  {analytics.pendingReplenishmentsCount} open restock orders
                </p>
              </div>
            </div>

            {/* Revenue & Trend Chart + Payer Breakdown */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              <section className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-7">
                <div className="flex items-center justify-between">
                  <h2 className="font-display text-base font-bold text-slate-900">
                    Daily Sales (Last 6 Days)
                  </h2>
                  <TrendingUp className="h-5 w-5 text-orange-600" />
                </div>

                <div className="mt-6">
                  <div className="grid h-56 grid-cols-6 items-end gap-3 border-b border-slate-200 pb-2">
                    {analytics.dailyTrends.map((day, idx) => {
                      const rxHeight = Math.max(
                        8,
                        Math.round((day.rxRevenueCents / maxTrendRevenue) * 170)
                      );
                      const otcHeight = Math.max(
                        6,
                        Math.round((day.otcRevenueCents / maxTrendRevenue) * 170)
                      );
                      const isHovered = hoveredDayIdx === idx;
                      return (
                        <div
                          key={day.date}
                          onMouseEnter={() => setHoveredDayIdx(idx)}
                          onMouseLeave={() => setHoveredDayIdx(null)}
                          className="flex flex-col items-center justify-end gap-1.5 h-full cursor-pointer"
                        >
                          <span className="font-mono text-[10px] font-semibold text-slate-600 tabular-nums">
                            {formatMoney(day.rxRevenueCents + day.otcRevenueCents)}
                          </span>
                          <div
                            className={`flex w-full max-w-[44px] flex-col overflow-hidden rounded-t-md transition-opacity ${
                              hoveredDayIdx !== null && !isHovered ? 'opacity-60' : 'opacity-100'
                            }`}
                          >
                            <div
                              style={{ height: `${otcHeight}px` }}
                              className="w-full bg-slate-900"
                              title={`OTC: ${formatMoney(day.otcRevenueCents)}`}
                            />
                            <div
                              style={{ height: `${rxHeight}px` }}
                              className="w-full bg-orange-600"
                              title={`Rx: ${formatMoney(day.rxRevenueCents)}`}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-2 grid grid-cols-6 text-center">
                    {analytics.dailyTrends.map((day) => (
                      <div key={day.date} className="text-[11px] text-slate-500">
                        <span className="font-mono tabular-nums">{day.date}</span>
                        <br />
                        <span className="font-mono text-[10px] text-slate-400 tabular-nums">
                          {day.rxCount} Rx
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 flex items-center gap-5 text-xs text-slate-600">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-xs bg-orange-600" />
                      Rx Revenue
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-xs bg-slate-900" />
                      OTC Retail Shop
                    </span>
                  </div>
                </div>
              </section>

              {/* Payer Mix & Top Stock Exposure */}
              <div className="space-y-6 lg:col-span-5">
                <section className="rounded-xl border border-slate-200 bg-white p-5">
                  <div className="flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-orange-600" />
                    <h2 className="font-display text-sm font-bold text-slate-900">
                      Insurance Payer Reimbursement Mix
                    </h2>
                  </div>
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-slate-200 text-slate-500">
                        <tr>
                          <th className="py-2 font-semibold">Payer</th>
                          <th className="py-2 font-semibold text-right">Claims</th>
                          <th className="py-2 font-semibold text-right">Insurer Paid</th>
                          <th className="py-2 font-semibold text-right">Copays</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {analytics.payerBreakdown.map((p) => (
                          <tr key={p.payerName}>
                            <td className="py-2.5 font-medium text-slate-900">{p.payerName}</td>
                            <td className="py-2.5 text-right font-mono tabular-nums">
                              {p.claimCount}
                            </td>
                            <td className="py-2.5 text-right font-mono font-semibold text-emerald-700 tabular-nums">
                              {formatMoney(p.insurerPaidCents)}
                            </td>
                            <td className="py-2.5 text-right font-mono text-slate-700 tabular-nums">
                              {formatMoney(p.copayCents)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="rounded-xl border border-slate-200 bg-white p-5">
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-orange-600" />
                    <h2 className="font-display text-sm font-bold text-slate-900">
                      Lowest Stock &amp; Automated Par Levels
                    </h2>
                  </div>
                  <div className="mt-3 space-y-2.5">
                    {analytics.topMedications.map((m) => {
                      const pct = Math.min(
                        100,
                        Math.round((m.stockQuantity / Math.max(1, m.reorderThreshold * 2)) * 100)
                      );
                      const isLow = m.stockQuantity <= m.reorderThreshold;
                      return (
                        <div key={m.name} className="text-xs">
                          <div className="flex justify-between">
                            <span className="font-medium text-slate-800 truncate pr-2">
                              {m.name}
                            </span>
                            <span
                              className={`font-mono font-semibold tabular-nums shrink-0 ${
                                isLow ? 'text-red-600' : 'text-slate-700'
                              }`}
                            >
                              {m.stockQuantity} / {m.reorderThreshold} min
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                            <div
                              style={{ width: `${pct}%` }}
                              className={`h-full ${isLow ? 'bg-red-500' : 'bg-orange-600'}`}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </div>
            </div>

            {/* Immutable HIPAA & GDPR Audit Ledger with Search, Action Filter & CSV Export */}
            <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="flex flex-col justify-between gap-3 border-b border-slate-200 px-5 py-4 lg:flex-row lg:items-center">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 shrink-0 text-orange-600" />
                  <h2 className="font-display text-sm font-bold text-slate-900">
                    Activity Log
                  </h2>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative w-48 sm:w-56">
                    <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
                    <input
                      type="text"
                      value={auditSearch}
                      onChange={(e) => setAuditSearch(e.target.value)}
                      placeholder="Filter actor or summary..."
                      className="w-full rounded-lg border border-slate-300 bg-white pl-8 pr-3 py-1.5 text-xs focus:border-orange-500 focus:outline-none"
                    />
                  </div>
                  <select
                    value={auditActionFilter}
                    onChange={(e) => setAuditActionFilter(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs focus:border-orange-500 focus:outline-none"
                  >
                    <option value="ALL">All Actions ({analytics.auditLogs.length})</option>
                    {distinctAuditActions.map((act) => (
                      <option key={act} value={act}>
                        {act}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleDownloadAuditCsv}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-orange-500"
                  >
                    <Download className="h-3.5 w-3.5 text-orange-600" />
                    Download Audit CSV
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">Timestamp</th>
                      <th className="px-4 py-2.5 font-semibold">Actor</th>
                      <th className="px-4 py-2.5 font-semibold">Action</th>
                      <th className="px-4 py-2.5 font-semibold">Summary</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredAuditLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-slate-50/60">
                        <td className="px-4 py-2.5 font-mono text-[11px] text-slate-500 whitespace-nowrap tabular-nums">
                          {new Date(log.createdAt).toLocaleString()}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          <span className="font-semibold text-slate-800">{log.actorName}</span>
                          <span className="ml-1.5 text-[11px] text-slate-500">({log.actorRole})</span>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[11px] font-semibold text-orange-700 whitespace-nowrap">
                          {log.action}
                        </td>
                        <td className="px-4 py-2.5 text-slate-700">{log.summary}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
};
