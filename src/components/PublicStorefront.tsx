import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Info,
  Minus,
  PackageCheck,
  Plus,
  Search,
  ShoppingBag,
  Stethoscope,
  Trash2,
  X,
} from 'lucide-react';
import {
  INVENTORY_CATEGORIES,
  type AuthUser,
  type InventoryCategory,
  type InventoryItem,
  type OtcOrder,
  type PharmacyService,
} from '../types.ts';
import { apiFetch, formatMoney } from '../utils/api.ts';
import { NetanyaLogo } from './NetanyaLogo.tsx';
import { PWAInstallButton } from './PWAControls.tsx';

interface PublicStorefrontProps {
  items: InventoryItem[];
  services: PharmacyService[];
  acceptedPlans: Array<{
    id: string;
    payerName: string;
    bin: string;
    pcn: string;
    groupPrefix: string;
  }>;
  loading: boolean;
  user: AuthUser | null;
  onOpenAuth: () => void;
  onEnterPortal: () => void;
  onOrderCompleted: () => void;
}

interface CartEntry {
  item: InventoryItem;
  quantity: number;
}

const HERO_IMG = '/src/assets/images/hero_pharmacy_dispensary_1794919114919.jpg';

export const PublicStorefront: React.FC<PublicStorefrontProps> = ({
  items,
  services,
  acceptedPlans,
  loading,
  user,
  onOpenAuth,
  onEnterPortal,
  onOrderCompleted,
}) => {
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | InventoryCategory>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [cart, setCart] = useState<CartEntry[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [heroImgFailed, setHeroImgFailed] = useState(false);
  const [brokenImages, setBrokenImages] = useState<Record<string, boolean>>({});
  const [selectedInfoItem, setSelectedInfoItem] = useState<InventoryItem | null>(null);

  // Checkout state
  const [customerName, setCustomerName] = useState(user?.displayName || '');
  const [customerEmail, setCustomerEmail] = useState(user?.email || '');
  const [fulfillmentType, setFulfillmentType] = useState<'pickup' | 'delivery'>('pickup');
  const [shippingAddress, setShippingAddress] = useState('');
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [confirmedOrder, setConfirmedOrder] = useState<OtcOrder | null>(null);

  const availableCategories = useMemo(
    () => INVENTORY_CATEGORIES.filter((cat) => items.some((i) => i.category === cat)),
    [items]
  );

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return items.filter((item) => {
      if (categoryFilter !== 'ALL' && item.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q) ||
        item.ndcCode.toLowerCase().includes(q)
      );
    });
  }, [items, categoryFilter, searchQuery]);

  const groupedSections = useMemo(() => {
    const order =
      categoryFilter === 'ALL'
        ? availableCategories
        : availableCategories.filter((c) => c === categoryFilter);
    return order
      .map((cat) => ({
        category: cat,
        items: filteredItems.filter((item) => item.category === cat),
      }))
      .filter((sec) => sec.items.length > 0);
  }, [availableCategories, categoryFilter, filteredItems]);

  const totalBagCount = useMemo(
    () => cart.reduce((sum, entry) => sum + entry.quantity, 0),
    [cart]
  );

  const subtotalCents = useMemo(
    () => cart.reduce((sum, entry) => sum + entry.item.unitPriceCents * entry.quantity, 0),
    [cart]
  );
  const taxCents = Math.round(subtotalCents * 0.15);
  const totalCents = subtotalCents + taxCents;

  const addToCart = (item: InventoryItem) => {
    if (item.stockQuantity <= 0) return;
    setConfirmedOrder(null);
    setCart((prev) => {
      const existing = prev.find((e) => e.item.id === item.id);
      if (existing) {
        const nextQty = Math.min(item.stockQuantity, existing.quantity + 1);
        return prev.map((e) => (e.item.id === item.id ? { ...e, quantity: nextQty } : e));
      }
      return [...prev, { item, quantity: 1 }];
    });
    setCartOpen(true);
  };

  const updateCartQty = (id: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((entry) => {
          if (entry.item.id !== id) return entry;
          const next = Math.min(entry.item.stockQuantity, entry.quantity + delta);
          return next <= 0 ? null : { ...entry, quantity: next };
        })
        .filter((x): x is CartEntry => x !== null)
    );
  };

  const handleCheckout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cart.length === 0) return;
    setCheckoutBusy(true);
    setCheckoutError(null);
    try {
      const res = await apiFetch<{ order: OtcOrder }>('/api/public/orders', {
        method: 'POST',
        body: JSON.stringify({
          customerName: customerName || user?.displayName,
          customerEmail: customerEmail || user?.email,
          fulfillmentType,
          shippingAddress,
          items: cart.map((c) => ({ inventoryId: c.item.id, quantity: c.quantity })),
        }),
      });
      setConfirmedOrder(res.order);
      setCart([]);
      onOrderCompleted();
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : 'Unable to place order.');
    } finally {
      setCheckoutBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-white text-slate-900">
      {/* 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-xs">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-8 px-4 py-4 sm:px-6 lg:px-8">
          {/* Zone 1: Brand Title */}
          <a
            href="#top"
            className="inline-flex items-center gap-2.5 font-display text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 sm:text-lg"
          >
            <NetanyaLogo size={36} />
            <span>
              NETANYA PHARMACY <span className="text-orange-600">&amp; RETAIL SHOP</span>
            </span>
          </a>

          {/* Zone 2: 3 Single-line Nav Links */}
          <nav
            aria-label="Primary"
            className="hidden lg:flex items-center gap-7 text-sm font-medium text-slate-600"
          >
            <a
              href="#retail-shop"
              className="hover:text-orange-600 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Shop
            </a>
            <a
              href="#clinical-services"
              className="hover:text-orange-600 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Services
            </a>
            <a
              href="#insurance"
              className="hover:text-orange-600 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Insurance
            </a>
          </nav>

          {/* Zone 3: 1 Primary Action */}
          <div className="flex items-center shrink-0">
            {user ? (
              <button
                type="button"
                onClick={onEnterPortal}
                className="rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700 transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
              >
                My Account
              </button>
            ) : (
              <button
                type="button"
                onClick={onOpenAuth}
                className="rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700 transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
              >
                Sign In
              </button>
            )}
          </div>
        </div>
      </header>

      <main id="top">
        {/* Hero Split */}
        <section className="border-b border-slate-200 bg-white">
          <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
            <div className="grid grid-cols-1 items-stretch gap-10 lg:grid-cols-12">
              <div className="flex flex-col justify-between lg:col-span-6">
                <div>
                  <h1 className="font-display text-3xl font-bold tracking-tight text-slate-900 sm:text-5xl [text-wrap:balance] leading-[1.1]">
                    Your Health is Our Number One Priority.
                  </h1>
                  <p className="mt-4 max-w-lg text-base leading-relaxed text-slate-600">
                    Shop medicines and wellness items for pickup or delivery, manage prescriptions,
                    and message our pharmacists anytime.
                  </p>
                </div>

                <div className="mt-8 flex flex-wrap items-center gap-4">
                  <a
                    href="#retail-shop"
                    className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-5 py-3 text-sm font-semibold text-white hover:bg-orange-700 transition-colors min-h-[44px]"
                  >
                    Shop Now
                    <ArrowRight className="h-4 w-4" />
                  </a>
                  <button
                    type="button"
                    onClick={() => (user ? onEnterPortal() : onOpenAuth())}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 hover:border-orange-400 hover:text-orange-700 transition-colors min-h-[44px]"
                  >
                    {user ? 'My Account' : 'Sign In'}
                  </button>
                  <PWAInstallButton variant="compact" />
                </div>
              </div>

              <div className="lg:col-span-6">
                <div className="h-full min-h-[300px] overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
                  {!heroImgFailed ? (
                    <img
                      src={HERO_IMG}
                      alt="Inside Netanya Pharmacy & Retail Shop counter"
                      referrerPolicy="no-referrer"
                      onError={() => setHeroImgFailed(true)}
                      className="h-full w-full object-cover lg:h-full"
                    />
                  ) : (
                    <div className="flex h-full min-h-[300px] flex-col items-center justify-center bg-gradient-to-br from-orange-50 via-white to-slate-50 p-8 text-center">
                      <Stethoscope className="h-12 w-12 text-orange-600" />
                      <p className="mt-3 font-display text-lg font-semibold text-slate-900">
                        NETANYA PHARMACY &amp; RETAIL SHOP
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Retail Shop Section */}
        <section id="retail-shop" className="border-b border-slate-200 bg-slate-50/60 py-14">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <h2 className="font-display text-2xl font-bold text-slate-900 sm:text-3xl">
                  Medicine &amp; Retail Shop
                </h2>
              </div>

              {/* Search & Shopping Bag */}
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search medicines..."
                    aria-label="Search shop"
                    className="w-52 rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-xs text-slate-900 focus:border-orange-500 focus:outline-none sm:w-64 min-h-[40px]"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => setCartOpen(true)}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-900 hover:border-orange-500 hover:text-orange-700 transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
                >
                  <ShoppingBag className="h-4 w-4 text-orange-600" />
                  <span>Bag</span>
                  <span className="font-mono tabular-nums text-orange-600">({totalBagCount})</span>
                </button>
              </div>
            </div>

            {/* Category Filter Bar */}
            <div className="mt-5 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setCategoryFilter('ALL')}
                className={`rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                  categoryFilter === 'ALL'
                    ? 'bg-orange-600 text-white'
                    : 'border border-slate-200 bg-white text-slate-600 hover:border-orange-400 hover:text-slate-900'
                }`}
              >
                All Categories ({items.length})
              </button>
              {availableCategories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategoryFilter(cat)}
                  className={`rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                    categoryFilter === cat
                      ? 'bg-orange-600 text-white'
                      : 'border border-slate-200 bg-white text-slate-600 hover:border-orange-400 hover:text-slate-900'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>

            {loading ? (
              <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
                {[1, 2, 3, 4].map((n) => (
                  <div
                    key={n}
                    className="h-80 animate-pulse rounded-xl border border-slate-200 bg-white p-4"
                  />
                ))}
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="mt-8 rounded-xl border border-slate-200 bg-white p-10 text-center">
                <p className="text-sm font-semibold text-slate-900">
                  No items match your search.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setCategoryFilter('ALL');
                    setSearchQuery('');
                  }}
                  className="mt-3 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700"
                >
                  Show All Items
                </button>
              </div>
            ) : (
              <div className="mt-8 space-y-10">
                {groupedSections.map((section) => (
                  <div key={section.category}>
                    <div className="mb-4 flex items-center justify-between border-b border-slate-200 pb-2">
                      <h3 className="font-display text-lg font-bold text-slate-900">
                        {section.category}
                      </h3>
                      <span className="font-mono text-xs font-semibold text-slate-500 tabular-nums">
                        {section.items.length} {section.items.length === 1 ? 'item' : 'items'}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
                      {section.items.map((item) => {
                        const isLow = item.stockQuantity <= item.reorderThreshold;
                        const outOfStock = item.stockQuantity <= 0;
                        return (
                          <article
                            key={item.id}
                            className="group flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-4 transition-transform duration-150 hover:-translate-y-0.5"
                          >
                            <div>
                              <button
                                type="button"
                                onClick={() => setSelectedInfoItem(item)}
                                className="block aspect-[4/3] w-full overflow-hidden rounded-lg bg-white border border-slate-100 focus:outline-none focus:ring-2 focus:ring-orange-500"
                                title="View official manufacturer details"
                              >
                                {item.imageUrl && !brokenImages[item.id] ? (
                                  <img
                                    src={item.imageUrl}
                                    alt={item.name}
                                    referrerPolicy="no-referrer"
                                    onError={() =>
                                      setBrokenImages((prev) => ({ ...prev, [item.id]: true }))
                                    }
                                    className="h-full w-full object-contain p-2 transition-transform duration-150 group-hover:scale-105"
                                  />
                                ) : (
                                  <div className="flex h-full w-full flex-col items-center justify-center bg-orange-50/50 p-4 text-center">
                                    <PackageCheck className="h-8 w-8 text-orange-600" />
                                    <span className="mt-2 text-xs font-medium text-slate-600">
                                      {item.category}
                                    </span>
                                  </div>
                                )}
                              </button>

                              <div className="mt-3 flex items-center justify-between gap-2 text-xs text-slate-500">
                                <span className="truncate font-medium text-slate-600">
                                  {item.manufacturerName || item.category}
                                </span>
                                <span className="font-mono text-[11px] tabular-nums shrink-0">
                                  {item.ndcCode}
                                </span>
                              </div>

                              <button
                                type="button"
                                onClick={() => setSelectedInfoItem(item)}
                                className="mt-1 text-left font-display text-base font-semibold text-slate-900 leading-snug hover:text-orange-600 transition-colors"
                              >
                                {item.name}
                              </button>
                              <p className="mt-1.5 text-xs leading-relaxed text-slate-600 line-clamp-2">
                                {item.description}
                              </p>
                            </div>

                            <div className="mt-4 flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
                              <div>
                                <div className="font-mono text-base font-bold text-slate-900 tabular-nums">
                                  {formatMoney(item.unitPriceCents)}
                                </div>
                                <div
                                  className={`text-[11px] font-medium tabular-nums ${
                                    outOfStock
                                      ? 'text-red-600'
                                      : isLow
                                        ? 'text-amber-700'
                                        : 'text-emerald-700'
                                  }`}
                                >
                                  {outOfStock
                                    ? 'Out of stock'
                                    : `${item.stockQuantity} in stock`}
                                </div>
                              </div>

                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setSelectedInfoItem(item)}
                                  className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-semibold text-slate-700 hover:border-orange-500 hover:text-orange-600 transition-colors min-h-[40px]"
                                  title="Official product info & usage"
                                >
                                  <Info className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={outOfStock}
                                  onClick={() => addToCart(item)}
                                  className="rounded-lg bg-orange-600 px-3 py-2 text-xs font-semibold text-white hover:bg-orange-700 disabled:bg-slate-200 disabled:text-slate-500 transition-colors min-h-[40px]"
                                >
                                  Add to Bag
                                </button>
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Walk-In Pharmacy Services & Accepted Insurance */}
        <section id="clinical-services" className="border-b border-slate-200 bg-white py-14">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="grid grid-cols-1 gap-10 lg:grid-cols-12 items-start">
              <div className="lg:col-span-7">
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <h2 className="font-display text-2xl font-bold text-slate-900 sm:text-3xl">
                      Walk-In Tests &amp; Services
                    </h2>
                    <p className="mt-1 text-xs text-slate-600">
                      Fast counter checks done by our pharmacy team—no appointment needed.
                    </p>
                  </div>
                </div>

                <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {services.map((srv) => (
                    <div
                      key={srv.id}
                      className="flex flex-col justify-between rounded-xl border border-slate-200 bg-slate-50/50 p-4"
                    >
                      <div>
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="font-display text-sm font-bold text-slate-900">
                            {srv.name}
                          </h3>
                          <span className="font-mono text-sm font-bold text-orange-600 tabular-nums shrink-0">
                            {formatMoney(srv.priceCents)}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-slate-600 leading-relaxed">{srv.notes}</p>
                      </div>
                      <div className="mt-3 flex items-center justify-between border-t border-slate-200/70 pt-2 text-[11px] text-slate-500">
                        <span>{srv.category}</span>
                        <span className="font-mono tabular-nums">~{srv.turnaroundMinutes} mins</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Insurance Network Coverage */}
              <div id="insurance" className="lg:col-span-5">
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-6">
                  <div className="flex items-center justify-between">
                    <h3 className="font-display text-lg font-bold text-slate-900">
                      Accepted Health Insurance
                    </h3>
                    <CreditCard className="h-5 w-5 text-orange-600" />
                  </div>

                  <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                        <tr>
                          <th className="px-4 py-2.5 font-semibold">Scheme</th>
                          <th className="px-4 py-2.5 font-semibold">BIN</th>
                          <th className="px-4 py-2.5 font-semibold">PCN</th>
                          <th className="px-4 py-2.5 font-semibold">Group Prefix</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {acceptedPlans.map((plan) => (
                          <tr key={plan.id} className="hover:bg-slate-50">
                            <td className="px-4 py-3 font-medium text-slate-900">
                              {plan.payerName}
                            </td>
                            <td className="px-4 py-3 font-mono text-slate-700 tabular-nums">
                              {plan.bin}
                            </td>
                            <td className="px-4 py-3 font-mono text-slate-700 tabular-nums">
                              {plan.pcn}
                            </td>
                            <td className="px-4 py-3 font-mono text-slate-600 tabular-nums">
                              {plan.groupPrefix}*
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-slate-50 py-8">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-4 px-4 sm:flex-row sm:items-center sm:px-6 lg:px-8">
          <div>
            <p className="font-display text-sm font-bold text-slate-900">
              NETANYA PHARMACY &amp; RETAIL SHOP
            </p>
            <p className="mt-0.5 text-xs text-slate-500">Accra, Ghana</p>
          </div>
          <div className="flex items-center gap-4">
            <PWAInstallButton variant="compact" />
            <span className="text-xs text-slate-500">© 2026 Netanya Pharmacy</span>
          </div>
        </div>
      </footer>

      {/* Slide-Over Cart & Retail Checkout Drawer */}
      {cartOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40 backdrop-blur-xs">
          <div
            className="flex h-full w-full max-w-md flex-col bg-white shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="Retail shopping bag"
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <h2 className="font-display text-lg font-bold text-slate-900">
                Bag ({totalBagCount})
              </h2>
              <button
                type="button"
                onClick={() => setCartOpen(false)}
                className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                aria-label="Close shopping bag"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {confirmedOrder ? (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
                  <div className="flex items-center gap-2 text-emerald-800">
                    <CheckCircle2 className="h-5 w-5" />
                    <h3 className="font-display text-base font-bold">
                      Order {confirmedOrder.orderNumber} Confirmed
                    </h3>
                  </div>
                  <p className="mt-2 text-xs text-emerald-900">
                    Fulfillment:{' '}
                    <strong>
                      {confirmedOrder.fulfillmentType === 'pickup'
                        ? 'In-Store Pharmacy Pickup'
                        : 'Local Courier Delivery'}
                    </strong>
                    <br />
                    Destination: {confirmedOrder.shippingAddress}
                  </p>
                  <div className="mt-4 space-y-1 border-t border-emerald-200 pt-3 text-xs text-emerald-900">
                    {confirmedOrder.items.map((it) => (
                      <div key={it.inventoryId} className="flex justify-between">
                        <span>
                          {it.quantity}× {it.name}
                        </span>
                        <span className="font-mono tabular-nums">
                          {formatMoney(it.unitPriceCents * it.quantity)}
                        </span>
                      </div>
                    ))}
                    <div className="flex justify-between pt-2 font-bold">
                      <span>Total Paid</span>
                      <span className="font-mono tabular-nums">
                        {formatMoney(confirmedOrder.totalCents)}
                      </span>
                    </div>
                  </div>
                </div>
              ) : cart.length === 0 ? (
                <div className="py-12 text-center">
                  <ShoppingBag className="mx-auto h-10 w-10 text-slate-300" />
                  <p className="mt-3 text-sm font-semibold text-slate-800">Your bag is empty</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {cart.map((entry) => (
                    <div
                      key={entry.item.id}
                      className="flex items-start justify-between gap-3 border-b border-slate-100 pb-4"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-slate-900">{entry.item.name}</p>
                        <p className="mt-0.5 font-mono text-xs text-slate-500 tabular-nums">
                          {formatMoney(entry.item.unitPriceCents)} each
                        </p>
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => updateCartQty(entry.item.id, -1)}
                            className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50"
                            aria-label="Decrease quantity"
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </button>
                          <span className="w-6 text-center font-mono text-xs font-semibold tabular-nums">
                            {entry.quantity}
                          </span>
                          <button
                            type="button"
                            onClick={() => updateCartQty(entry.item.id, 1)}
                            className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50"
                            aria-label="Increase quantity"
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-mono text-sm font-bold text-slate-900 tabular-nums">
                          {formatMoney(entry.item.unitPriceCents * entry.quantity)}
                        </p>
                        <button
                          type="button"
                          onClick={() => updateCartQty(entry.item.id, -99)}
                          className="mt-2 inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-red-600"
                        >
                          <Trash2 className="h-3 w-3" />
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}

                  <form id="otc-checkout-form" onSubmit={handleCheckout} className="space-y-3 pt-2">
                    <h3 className="text-xs font-bold text-slate-900">Fulfillment &amp; Customer Details</h3>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setFulfillmentType('pickup')}
                        className={`flex-1 rounded-lg border py-2 text-xs font-semibold transition-colors ${
                          fulfillmentType === 'pickup'
                            ? 'border-orange-600 bg-orange-50 text-orange-700'
                            : 'border-slate-200 text-slate-600'
                        }`}
                      >
                        In-Store Pickup
                      </button>
                      <button
                        type="button"
                        onClick={() => setFulfillmentType('delivery')}
                        className={`flex-1 rounded-lg border py-2 text-xs font-semibold transition-colors ${
                          fulfillmentType === 'delivery'
                            ? 'border-orange-600 bg-orange-50 text-orange-700'
                            : 'border-slate-200 text-slate-600'
                        }`}
                      >
                        Local Delivery
                      </button>
                    </div>

                    <input
                      type="text"
                      required
                      value={customerName || user?.displayName || ''}
                      onChange={(e) => setCustomerName(e.target.value)}
                      placeholder="Full Name"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-orange-500 focus:outline-none"
                    />
                    <input
                      type="email"
                      required
                      value={customerEmail || user?.email || ''}
                      onChange={(e) => setCustomerEmail(e.target.value)}
                      placeholder="Receipt Email"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-orange-500 focus:outline-none"
                    />
                    {fulfillmentType === 'delivery' && (
                      <input
                        type="text"
                        required
                        value={shippingAddress}
                        onChange={(e) => setShippingAddress(e.target.value)}
                        placeholder="Delivery Street, Area & GhanaPost GPS (e.g., GA-184-2201)"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-orange-500 focus:outline-none"
                      />
                    )}
                    {checkoutError && (
                      <p className="text-xs font-medium text-red-600">{checkoutError}</p>
                    )}
                  </form>
                </div>
              )}
            </div>

            {cart.length > 0 && (
              <div className="border-t border-slate-200 bg-slate-50 p-6">
                <div className="space-y-1.5 text-xs text-slate-600">
                  <div className="flex justify-between">
                    <span>Subtotal</span>
                    <span className="font-mono tabular-nums">{formatMoney(subtotalCents)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Estimated VAT &amp; Levies (15%)</span>
                    <span className="font-mono tabular-nums">{formatMoney(taxCents)}</span>
                  </div>
                  <div className="flex justify-between border-t border-slate-200 pt-2 text-sm font-bold text-slate-900">
                    <span>Total</span>
                    <span className="font-mono tabular-nums">{formatMoney(totalCents)}</span>
                  </div>
                </div>
                <button
                  type="submit"
                  form="otc-checkout-form"
                  disabled={checkoutBusy}
                  className="mt-4 w-full rounded-lg bg-orange-600 py-3 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-50 transition-colors"
                >
                  {checkoutBusy ? 'Processing Order...' : 'Complete Retail Order'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Official Product & Manufacturer Info Modal */}
      {selectedInfoItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-200 bg-white">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
              <div>
                <div className="text-xs font-semibold text-orange-600">
                  {selectedInfoItem.category}
                </div>
                <h3 className="font-display text-lg font-bold text-slate-900">
                  {selectedInfoItem.name}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedInfoItem(null)}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
                aria-label="Close product info"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6 space-y-5">
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-12 items-start">
                <div className="sm:col-span-5 aspect-square overflow-hidden rounded-xl border border-slate-200 bg-white flex items-center justify-center p-3">
                  {selectedInfoItem.imageUrl && !brokenImages[selectedInfoItem.id] ? (
                    <img
                      src={selectedInfoItem.imageUrl}
                      alt={selectedInfoItem.name}
                      className="max-h-full max-w-full object-contain"
                    />
                  ) : (
                    <PackageCheck className="h-12 w-12 text-orange-600" />
                  )}
                </div>

                <div className="sm:col-span-7 space-y-3 text-xs">
                  <div>
                    <div className="font-semibold text-slate-500">Manufacturer</div>
                    <div className="text-sm font-semibold text-slate-900">
                      {selectedInfoItem.manufacturerName || selectedInfoItem.supplierName}
                    </div>
                  </div>

                  {selectedInfoItem.activeIngredient && (
                    <div>
                      <div className="font-semibold text-slate-500">Active Ingredient(s)</div>
                      <div className="text-slate-800">{selectedInfoItem.activeIngredient}</div>
                    </div>
                  )}

                  {selectedInfoItem.dosageForm && (
                    <div>
                      <div className="font-semibold text-slate-500">Form &amp; Pack Size</div>
                      <div className="text-slate-800">{selectedInfoItem.dosageForm}</div>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-4 pt-1">
                    <div>
                      <div className="font-semibold text-slate-500">Product Code</div>
                      <div className="font-mono text-slate-900 tabular-nums">
                        {selectedInfoItem.ndcCode}
                      </div>
                    </div>
                    <div>
                      <div className="font-semibold text-slate-500">Expiry</div>
                      <div className="font-mono text-slate-900 tabular-nums">
                        {selectedInfoItem.expiryDate}
                      </div>
                    </div>
                    <div>
                      <div className="font-semibold text-slate-500">Price</div>
                      <div className="font-mono text-sm font-bold text-slate-900 tabular-nums">
                        {formatMoney(selectedInfoItem.unitPriceCents)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-3 border-t border-slate-200 pt-4 text-xs leading-relaxed">
                <div>
                  <h4 className="font-semibold text-slate-900">What It Is For</h4>
                  <p className="mt-1 text-slate-700">{selectedInfoItem.description}</p>
                </div>

                {selectedInfoItem.usageDirections && (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <h4 className="font-semibold text-slate-900">How to Take / Use</h4>
                    <p className="mt-1 text-slate-700">{selectedInfoItem.usageDirections}</p>
                  </div>
                )}

                {selectedInfoItem.warnings && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                    <h4 className="font-semibold text-amber-900">Important Warnings</h4>
                    <p className="mt-1 text-amber-900">{selectedInfoItem.warnings}</p>
                  </div>
                )}

                {selectedInfoItem.storageInfo && (
                  <div>
                    <h4 className="font-semibold text-slate-900">Storage</h4>
                    <p className="mt-0.5 text-slate-600">{selectedInfoItem.storageInfo}</p>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
                {selectedInfoItem.officialSourceUrl ? (
                  <a
                    href={selectedInfoItem.officialSourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-orange-600 hover:text-orange-700"
                  >
                    Official Manufacturer / Regulatory Info
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : (
                  <span />
                )}

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedInfoItem(null)}
                    className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    disabled={selectedInfoItem.stockQuantity <= 0}
                    onClick={() => {
                      addToCart(selectedInfoItem);
                      setSelectedInfoItem(null);
                    }}
                    className="rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700 disabled:bg-slate-200 disabled:text-slate-500"
                  >
                    {selectedInfoItem.stockQuantity <= 0 ? 'Out of stock' : 'Add to Bag'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
