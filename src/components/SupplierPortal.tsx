import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  Download,
  LogOut,
  ShoppingBag,
} from 'lucide-react';
import type { AuthUser, ReplenishmentOrder } from '../types.ts';
import { apiFetch, useRealtimeTopics } from '../utils/api.ts';
import { NetanyaLogo } from './NetanyaLogo.tsx';
import { PWAInstallButton } from './PWAControls.tsx';

interface SupplierPortalProps {
  user: AuthUser;
  token: string;
  onGoToStorefront: () => void;
  onLogout: () => void;
}

type PoFilter = 'ALL' | 'awaiting_supplier' | 'active_delivery' | 'received';

export const SupplierPortal: React.FC<SupplierPortalProps> = ({
  user,
  token,
  onGoToStorefront,
  onLogout,
}) => {
  const [orders, setOrders] = useState<ReplenishmentOrder[]>([]);
  const [filter, setFilter] = useState<PoFilter>('ALL');
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<
    Record<
      string,
      {
        confirmedQty: number;
        batchNumber: string;
        batchExpiry: string;
        scheduledDeliveryDate: string;
        deliveryWindow: string;
      }
    >
  >({});

  const loadOrders = useCallback(async () => {
    try {
      const res = await apiFetch<{ orders: ReplenishmentOrder[] }>('/api/supplier/orders');
      setOrders(res.orders);
      const nextDrafts: typeof drafts = {};
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      for (const o of res.orders) {
        nextDrafts[o.id] = {
          confirmedQty: o.confirmedQty || o.requestedQty,
          batchNumber:
            o.batchNumber ||
            `LOT-${o.ndcCode.slice(0, 5)}-${o.poNumber.replace(/\D/g, '').slice(-4) || '1001'}`,
          batchExpiry: o.batchExpiry || '2028-11-30',
          scheduledDeliveryDate: o.scheduledDeliveryDate || tomorrow,
          deliveryWindow: o.deliveryWindow || '09:00 - 12:00',
        };
      }
      setDrafts(nextDrafts);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  useRealtimeTopics(['replenishments'], loadOrders, token);

  const filteredOrders = useMemo(() => {
    return orders.filter((po) => {
      if (filter === 'ALL') return true;
      if (filter === 'awaiting_supplier') return po.status === 'awaiting_supplier';
      if (filter === 'active_delivery') {
        return po.status === 'confirmed_scheduled' || po.status === 'in_transit';
      }
      return po.status === 'received';
    });
  }, [orders, filter]);

  const handleConfirm = async (
    po: ReplenishmentOrder,
    nextStatus: 'confirmed_scheduled' | 'in_transit'
  ) => {
    const d = drafts[po.id];
    if (!d) return;
    try {
      await apiFetch(`/api/supplier/orders/${po.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...d,
          status: nextStatus,
        }),
      });
      setToast(
        nextStatus === 'in_transit'
          ? `${po.poNumber} marked In Transit. Netanya Pharmacy staff notified automatically.`
          : `${po.poNumber} confirmed for delivery on ${d.scheduledDeliveryDate} (${d.deliveryWindow}).`
      );
      await loadOrders();
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Unable to update purchase order.');
    }
  };

  const handleExportManifest = () => {
    const headers = [
      'PO Number',
      'NDC',
      'Medication',
      'Requested Qty',
      'Confirmed Qty',
      'Batch',
      'Expiry',
      'Delivery Date',
      'Window',
      'Status',
    ];
    const rows = orders.map((o) => [
      o.poNumber,
      o.ndcCode,
      `"${o.medicationName.replace(/"/g, '""')}"`,
      o.requestedQty,
      o.confirmedQty ?? '',
      o.batchNumber ?? '',
      o.batchExpiry ?? '',
      o.scheduledDeliveryDate ?? '',
      o.deliveryWindow ?? '',
      o.status,
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `netanya-supplier-manifest-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-2.5 min-w-0">
            <NetanyaLogo size={34} />
            <div className="min-w-0">
              <span className="block truncate font-display text-sm font-bold text-slate-900">
                NETANYA PHARMACY
              </span>
              <span className="block truncate text-[11px] text-slate-500">{user.displayName}</span>
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
      </header>

      <main className="mx-auto max-w-6xl p-4 sm:p-6 space-y-6">
        <div className="flex flex-col justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-center">
          <h1 className="font-display text-lg font-bold text-slate-900">
            Restock Orders
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
              {(
                [
                  ['ALL', 'All'],
                  ['awaiting_supplier', 'Awaiting'],
                  ['active_delivery', 'Scheduled'],
                  ['received', 'Received'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                    filter === key
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={handleExportManifest}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-orange-500"
            >
              <Download className="h-3.5 w-3.5" />
              Download CSV
            </button>
          </div>
        </div>

        {toast && (
          <div className="flex items-center justify-between rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-xs font-medium text-orange-900">
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

        {loading ? (
          <div className="h-56 animate-pulse rounded-xl border border-slate-200 bg-white" />
        ) : filteredOrders.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-xs text-slate-500">
            No replenishment orders match this status filter.
          </div>
        ) : (
          <div className="space-y-4">
            {filteredOrders.map((po) => {
              const d = drafts[po.id];
              const isDone = po.status === 'received';
              return (
                <section
                  key={po.id}
                  className="rounded-xl border border-slate-200 bg-white p-5 space-y-4"
                >
                  <div className="flex flex-col justify-between gap-2 border-b border-slate-100 pb-3 sm:flex-row sm:items-center">
                    <div>
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-mono font-bold text-slate-900 tabular-nums">
                          {po.poNumber}
                        </span>
                        <span className="text-slate-400">·</span>
                        <span className="font-mono text-slate-600 tabular-nums">
                          NDC {po.ndcCode}
                        </span>
                        <span className="text-slate-400">·</span>
                        <span
                          className={`font-semibold uppercase ${
                            po.status === 'received'
                              ? 'text-emerald-700'
                              : po.status === 'awaiting_supplier'
                                ? 'text-amber-700'
                                : 'text-orange-600'
                          }`}
                        >
                          {po.status.replace('_', ' ')}
                        </span>
                      </div>
                      <h2 className="mt-1 font-display text-base font-bold text-slate-900">
                        {po.medicationName}
                      </h2>
                    </div>
                    <div className="font-mono text-xs text-slate-600 tabular-nums">
                      Requested Qty: <strong className="text-slate-900">{po.requestedQty}</strong>
                    </div>
                  </div>

                  {isDone ? (
                    <div className="flex items-center gap-2 text-xs font-semibold text-emerald-700">
                      <CheckCircle2 className="h-4 w-4" />
                      Delivered &amp; checked into Netanya Pharmacy inventory ({po.confirmedQty} units · Lot{' '}
                      {po.batchNumber})
                    </div>
                  ) : (
                    d && (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6 items-end">
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-600">
                            Confirmed Qty
                          </label>
                          <input
                            type="number"
                            min={1}
                            value={d.confirmedQty}
                            onChange={(e) =>
                              setDrafts((prev) => ({
                                ...prev,
                                [po.id]: { ...d, confirmedQty: Number(e.target.value) || 1 },
                              }))
                            }
                            className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono text-xs tabular-nums focus:border-orange-500 focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-600">
                            Lot / Batch #
                          </label>
                          <input
                            type="text"
                            value={d.batchNumber}
                            onChange={(e) =>
                              setDrafts((prev) => ({
                                ...prev,
                                [po.id]: { ...d, batchNumber: e.target.value },
                              }))
                            }
                            className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono text-xs focus:border-orange-500 focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-600">
                            Batch Expiry
                          </label>
                          <input
                            type="date"
                            value={d.batchExpiry}
                            onChange={(e) =>
                              setDrafts((prev) => ({
                                ...prev,
                                [po.id]: { ...d, batchExpiry: e.target.value },
                              }))
                            }
                            className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono text-xs focus:border-orange-500 focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-600">
                            Delivery Date
                          </label>
                          <input
                            type="date"
                            value={d.scheduledDeliveryDate}
                            onChange={(e) =>
                              setDrafts((prev) => ({
                                ...prev,
                                [po.id]: { ...d, scheduledDeliveryDate: e.target.value },
                              }))
                            }
                            className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono text-xs focus:border-orange-500 focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-600">
                            Delivery Window
                          </label>
                          <select
                            value={d.deliveryWindow}
                            onChange={(e) =>
                              setDrafts((prev) => ({
                                ...prev,
                                [po.id]: { ...d, deliveryWindow: e.target.value },
                              }))
                            }
                            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs focus:border-orange-500 focus:outline-none"
                          >
                            <option value="08:00 - 10:30">08:00 - 10:30</option>
                            <option value="09:00 - 12:00">09:00 - 12:00</option>
                            <option value="13:00 - 16:00">13:00 - 16:00</option>
                          </select>
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => handleConfirm(po, 'confirmed_scheduled')}
                            className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg border border-orange-600 bg-white px-3 py-2 text-xs font-semibold text-orange-600 hover:bg-orange-50 min-h-[38px]"
                          >
                            <CalendarClock className="h-3.5 w-3.5" />
                            Schedule
                          </button>
                          <button
                            type="button"
                            onClick={() => handleConfirm(po, 'in_transit')}
                            className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-orange-600 px-3 py-2 text-xs font-semibold text-white hover:bg-orange-700 min-h-[38px]"
                          >
                            Dispatch
                          </button>
                        </div>
                      </div>
                    )
                  )}
                </section>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
};
