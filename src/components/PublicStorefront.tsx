import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Info,
  Menu,
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
  type OtcOrder,
  type PharmacyService,
  type PublicInventoryItem,
} from '../types.ts';
import { faqGroups } from '../data/faqs.ts';
import { apiFetch, formatMoney } from '../utils/api.ts';
import { NetanyaLogo } from './NetanyaLogo.tsx';
import { PWAInstallButton } from './PWAControls.tsx';

interface PublicStorefrontProps {
  items: PublicInventoryItem[];
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
  item: PublicInventoryItem;
  quantity: number;
}

type StorefrontPage = 'home' | 'shop' | 'services' | 'insurance' | 'faqs';

const getStorefrontPage = (): StorefrontPage => {
  switch (window.location.pathname.replace(/\/+$/, '') || '/') {
    case '/shop':
      return 'shop';
    case '/services':
      return 'services';
    case '/insurance':
      return 'insurance';
    case '/faqs':
      return 'faqs';
    default:
      return 'home';
  }
};

const HERO_IMG = '/src/assets/images/netanya_pharmacy.png';
const SITE_URL = 'https://netanyapharmacy.com';

const pageMetadata: Record<StorefrontPage, { title: string; description: string }> = {
  home: {
    title: 'Netanya Pharmacy & Retail Shop | Afienya, Ghana',
    description:
      'Visit Netanya Pharmacy & Retail Shop at Afienya ECG Under Bridge, Ghana. Shop medicines and health products, and find pharmacy services and opening hours.',
  },
  shop: {
    title: 'Shop Medicines & Health Products | Netanya Pharmacy',
    description:
      'Shop medicines and health products from Netanya Pharmacy & Retail Shop in Afienya, Ghana, with convenient pickup or delivery.',
  },
  services: {
    title: 'Pharmacy Services in Afienya | Netanya Pharmacy',
    description:
      'Explore walk-in pharmacy tests and services at Netanya Pharmacy & Retail Shop, Afienya ECG Under Bridge, Ghana.',
  },
  insurance: {
    title: 'Accepted Health Insurance | Netanya Pharmacy Afienya',
    description:
      'See health insurance schemes accepted at Netanya Pharmacy & Retail Shop in Afienya, Ghana.',
  },
  faqs: {
    title: 'Health & Medicine FAQs | Netanya Pharmacy Afienya, Ghana',
    description:
      'General health and medicine FAQs from Netanya Pharmacy in Afienya, Ghana, covering malaria, fever, pain relief, antibiotics, coughs, diarrhea, and medicine safety.',
  },
};

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
  const [selectedInfoItem, setSelectedInfoItem] = useState<PublicInventoryItem | null>(null);
  const [page, setPage] = useState<StorefrontPage>(getStorefrontPage);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [headerScrolled, setHeaderScrolled] = useState(false);

  useEffect(() => {
    const metadata = pageMetadata[page];
    const canonicalUrl = `${SITE_URL}${window.location.pathname.replace(/\/+$/, '') || '/'}`;

    document.title = metadata.title;
    document.querySelector('meta[name="description"]')?.setAttribute('content', metadata.description);
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', metadata.title);
    document
      .querySelector('meta[property="og:description"]')
      ?.setAttribute('content', metadata.description);
    document.querySelector('meta[property="og:url"]')?.setAttribute('content', canonicalUrl);
    document.querySelector('meta[name="twitter:title"]')?.setAttribute('content', metadata.title);
    document
      .querySelector('meta[name="twitter:description"]')
      ?.setAttribute('content', metadata.description);
    document.querySelector('link[rel="canonical"]')?.setAttribute('href', canonicalUrl);
  }, [page]);

  useEffect(() => {
    const onScroll = () => setHeaderScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const navigateToPage = (path: string) => {
    window.history.pushState({}, '', path);
    setPage(getStorefrontPage());
    setMobileNavOpen(false);
    window.scrollTo(0, 0);
  };

  const handlePageLink = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    navigateToPage(event.currentTarget.pathname);
  };

  // Checkout state
  const [customerName, setCustomerName] = useState(user?.displayName || '');
  const [customerEmail, setCustomerEmail] = useState(user?.email || '');
  const [fulfillmentType, setFulfillmentType] = useState<'pickup' | 'delivery'>('pickup');
  const [shippingAddress, setShippingAddress] = useState('');
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [confirmedOrder, setConfirmedOrder] = useState<OtcOrder | null>(null);

  useEffect(() => {
    const handlePopState = () => {
      setPage(getStorefrontPage());
      window.scrollTo(0, 0);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reference = params.get('reference') || params.get('trxref');
    if (!reference) return;

    const rawPending = sessionStorage.getItem('netanya_pending_retail_checkout');
    if (!rawPending) {
      setCheckoutError('Payment returned, but the checkout details could not be recovered.');
      return;
    }

    let pending: {
      customerName: string;
      customerEmail: string;
      fulfillmentType: 'pickup' | 'delivery';
      shippingAddress: string;
      items: Array<{ inventoryId: string; quantity: number }>;
    };
    try {
      pending = JSON.parse(rawPending);
    } catch {
      setCheckoutError('Payment returned, but the checkout details could not be recovered.');
      return;
    }

    setCheckoutBusy(true);
    setCheckoutError(null);
    setCartOpen(true);
    apiFetch<{ order: OtcOrder }>('/api/public/orders', {
      method: 'POST',
      body: JSON.stringify({ ...pending, paymentReference: reference }),
    })
      .then((res) => {
        setConfirmedOrder(res.order);
        setCart([]);
        sessionStorage.removeItem('netanya_pending_retail_checkout');
        onOrderCompleted();
        const url = new URL(window.location.href);
        url.searchParams.delete('reference');
        window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
      })
      .catch((err) => {
        setCheckoutError(err instanceof Error ? err.message : 'Payment verification failed.');
      })
      .finally(() => setCheckoutBusy(false));
  }, [onOrderCompleted]);

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

  const addToCart = (item: PublicInventoryItem) => {
    if (!item.inStock) return;
    setConfirmedOrder(null);
    setCart((prev) => {
      const existing = prev.find((e) => e.item.id === item.id);
      if (existing) {
        const nextQty = Math.min(50, existing.quantity + 1);
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
          if (delta > 0 && !entry.item.inStock) return entry;
          const next = Math.min(50, entry.quantity + delta);
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
      const pendingCheckout = {
        customerName: customerName || user?.displayName || '',
        customerEmail: customerEmail || user?.email || '',
        fulfillmentType,
        shippingAddress,
        items: cart.map((c) => ({ inventoryId: c.item.id, quantity: c.quantity })),
      };
      sessionStorage.setItem(
        'netanya_pending_retail_checkout',
        JSON.stringify(pendingCheckout)
      );

      const res = await apiFetch<{ authorization_url: string }>(
        '/api/public/payments/initialize',
        {
        method: 'POST',
          body: JSON.stringify({
            customerEmail: pendingCheckout.customerEmail,
            items: pendingCheckout.items,
            callbackUrl: `${window.location.origin}${window.location.pathname}`,
          }),
        }
      );
      window.location.assign(res.authorization_url);
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : 'Unable to start payment.');
      sessionStorage.removeItem('netanya_pending_retail_checkout');
    } finally {
      setCheckoutBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-white text-slate-900">
      {/* Global site header */}
      <header
        className={`sticky top-0 z-40 border-b bg-white/90 backdrop-blur transition-shadow duration-300 ${
          headerScrolled ? 'border-slate-200 shadow-md shadow-slate-900/5' : 'border-transparent'
        }`}
      >
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          {/* Brand */}
          <a
            href="/"
            onClick={handlePageLink}
            className="flex min-w-0 items-center gap-2.5"
            aria-label="Netanya Pharmacy & Retail Shop — home"
          >
            <NetanyaLogo size={44} className="h-11 w-11" />
            <span className="flex min-w-0 flex-col leading-none">
              <span className="font-display text-base font-bold tracking-tight text-slate-900 sm:text-lg">
                NETANYA PHARMACY
              </span>
              <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-orange-600 sm:text-[11px]">
                &amp; Retail Shop
              </span>
            </span>
          </a>

          {/* Desktop nav */}
          <nav
            aria-label="Primary"
            className="hidden items-center gap-1 lg:flex"
          >
            {(
              [
                ['/', 'Home', 'home'],
                ['/shop', 'Shop', 'shop'],
                ['/services', 'Services', 'services'],
                ['/insurance', 'Insurance', 'insurance'],
                ['/faqs', 'FAQs', 'faqs'],
              ] as const
            ).map(([href, label, key]) => (
              <a
                key={key}
                href={href}
                onClick={handlePageLink}
                aria-current={page === key ? 'page' : undefined}
                className={`rounded-lg px-3 py-2 text-sm font-semibold transition-colors whitespace-nowrap ${
                  page === key
                    ? 'bg-orange-50 text-orange-700'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                {label}
              </a>
            ))}
          </nav>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setCartOpen(true)}
              aria-label={`Open bag, ${totalBagCount} item${totalBagCount === 1 ? '' : 's'}`}
              className="relative inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:border-orange-400 hover:text-orange-700 transition-colors min-h-[40px]"
            >
              <ShoppingBag className="h-4 w-4 text-orange-600" />
              <span className="hidden sm:inline">Bag</span>
              {totalBagCount > 0 && (
                <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-orange-600 px-1 font-mono text-[10px] font-bold tabular-nums text-white">
                  {totalBagCount}
                </span>
              )}
            </button>
            {user ? (
              <button
                type="button"
                onClick={onEnterPortal}
                className="rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700 transition-colors whitespace-nowrap min-h-[40px]"
              >
                My Account
              </button>
            ) : (
              <button
                type="button"
                onClick={onOpenAuth}
                className="rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700 transition-colors whitespace-nowrap min-h-[40px]"
              >
                Sign In
              </button>
            )}
            <button
              type="button"
              onClick={() => setMobileNavOpen((v) => !v)}
              aria-label={mobileNavOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={mobileNavOpen}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-slate-700 hover:border-orange-400 lg:hidden"
            >
              {mobileNavOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {/* Mobile nav panel */}
        {mobileNavOpen && (
          <nav
            aria-label="Mobile primary"
            className="border-t border-slate-100 bg-white px-4 pb-4 pt-2 lg:hidden"
          >
            <div className="flex flex-col gap-1">
              {(
                [
                  ['/', 'Home', 'home'],
                  ['/shop', 'Shop', 'shop'],
                  ['/services', 'Services', 'services'],
                  ['/insurance', 'Insurance', 'insurance'],
                  ['/faqs', 'FAQs', 'faqs'],
                ] as const
              ).map(([href, label, key]) => (
                <a
                  key={key}
                  href={href}
                  onClick={handlePageLink}
                  aria-current={page === key ? 'page' : undefined}
                  className={`rounded-lg px-3 py-2.5 text-sm font-semibold ${
                    page === key
                      ? 'bg-orange-50 text-orange-700'
                      : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {label}
                </a>
              ))}
              <button
                type="button"
                onClick={() => {
                  setMobileNavOpen(false);
                  setCartOpen(true);
                }}
                className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50"
              >
                <ShoppingBag className="h-4 w-4 text-orange-600" />
                Bag{totalBagCount > 0 ? ` (${totalBagCount})` : ''}
              </button>
            </div>
          </nav>
        )}
      </header>

      <main id="top">
        {page === 'home' && (
        <section key="home" className="relative overflow-hidden border-b border-slate-200 bg-white">
          {/* Decorative pharmacy motif layer */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 hidden lg:block">
            {/* Capsule */}
            <svg
              viewBox="0 0 64 32"
              className="absolute left-[4%] top-[16%] h-9 w-18 animate-float text-orange-200"
            >
              <rect x="1" y="1" width="62" height="30" rx="15" fill="currentColor" />
              <path d="M32 1v30" stroke="white" strokeWidth="2" />
              <rect x="1" y="1" width="31" height="30" rx="15" fill="white" opacity="0.65" />
            </svg>
            {/* Medical cross */}
            <svg
              viewBox="0 0 48 48"
              className="absolute right-[6%] top-[12%] h-11 w-11 animate-float-slow text-orange-300"
            >
              <circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.25" />
              <path
                d="M20 12h8v8h8v8h-8v8h-8v-8h-8v-8h8z"
                fill="currentColor"
              />
            </svg>
            {/* Heartbeat */}
            <svg
              viewBox="0 0 48 48"
              className="absolute bottom-[22%] left-[10%] h-10 w-10 animate-heartbeat text-orange-400"
            >
              <path
                d="M24 8c-6 0-10 4-10 9 0 5 4 7 6 10s4 8 4 13h0c0-5 2-10 4-13s6-5 6-10c0-5-4-9-10-9z"
                fill="currentColor"
                opacity="0.5"
              />
            </svg>
            {/* EKG vitals strip */}
            <svg
              className="absolute inset-x-0 bottom-0 h-14 w-full text-orange-500/70"
              preserveAspectRatio="none"
              viewBox="0 0 1200 56"
              aria-hidden="true"
            >
              <path
                d="M0 34 H220 L240 34 252 12 264 48 276 34 H420 L440 34 452 12 464 48 476 34 H620 L640 34 652 12 664 48 676 34 H820 L840 34 852 12 864 48 876 34 H1020 L1040 34 1052 12 1064 48 1076 34 H1200"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength="100"
                strokeDasharray="14 86"
                className="animate-ekg"
              />
            </svg>
          </div>

          <div className="relative mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
            <div className="grid grid-cols-1 items-stretch gap-10 lg:grid-cols-12">
              <div className="flex flex-col justify-between lg:col-span-6">
                <div>
                  <h1
                    className="animate-fade-up font-display text-3xl font-bold tracking-tight text-slate-900 sm:text-5xl [text-wrap:balance] leading-[1.1]"
                    style={{ animationDelay: '40ms' }}
                  >
                    Your Health is Our Number One Priority.
                  </h1>
                  <p
                    className="animate-fade-up mt-4 max-w-lg text-base leading-relaxed text-slate-600"
                    style={{ animationDelay: '120ms' }}
                  >
                    Shop medicines and wellness items for pickup or delivery, manage prescriptions,
                    and message our pharmacists anytime.
                  </p>
                </div>

                <div
                  className="animate-fade-up mt-8 flex flex-wrap items-center gap-4"
                  style={{ animationDelay: '200ms' }}
                >
                  <a
                    href="/shop"
                    onClick={handlePageLink}
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

              <div className="animate-fade-up lg:col-span-6" style={{ animationDelay: '240ms' }}>
                <div className="h-full min-h-[300px] overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-sm">
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
        )}

        {/* Retail Shop Section */}
        {page === 'shop' && (
        <section key="shop" className="animate-fade-up border-b border-slate-200 bg-slate-50/60 py-14">
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
                      {section.items.map((item, idx) => {
                        const outOfStock = !item.inStock;
                        return (
                          <article
                            key={item.id}
                            className="group animate-fade-up flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md"
                            style={{ animationDelay: `${Math.min(idx, 8) * 45}ms` }}
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
                                      : 'text-emerald-700'
                                  }`}
                                >
                                  {outOfStock
                                    ? 'Out of stock'
                                    : 'In stock'}
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
        )}

        {/* Walk-In Pharmacy Services & Accepted Insurance */}
        {(page === 'services' || page === 'insurance') && (
        <section key={page} className="animate-fade-up border-b border-slate-200 bg-white py-14">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className={`grid grid-cols-1 gap-10 items-start ${page === 'insurance' ? 'lg:grid-cols-1' : 'lg:grid-cols-12'}`}>
              {page !== 'insurance' && (
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
              )}

              {/* Insurance Network Coverage */}
              {page !== 'services' && (
              <div className={page === 'insurance' ? 'lg:col-span-1' : 'lg:col-span-5'}>
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
              )}
            </div>
          </div>
        </section>
        )}

        {page === 'faqs' && (
          <section className="animate-fade-up border-b border-slate-200 bg-white py-14">
            <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
              <header className="mb-10">
                <h1 className="font-display text-3xl font-bold text-slate-900 sm:text-4xl">
                  Health &amp; Medicine FAQs
                </h1>
                <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-600">
                  General information about malaria, fever, common medicines, infections, and
                  pharmacy care. This page cannot diagnose illness or recommend a treatment for
                  your individual situation. Linked references may not describe Ghanaian care
                  protocols. Ask a qualified local health professional for advice, and seek
                  urgent care for severe symptoms.
                </p>
              </header>

              <div className="space-y-10">
                {faqGroups.map((group, index) => (
                  <section key={group.title} aria-labelledby={`faq-group-${index}`}>
                    <h2
                      id={`faq-group-${index}`}
                      className="mb-4 font-display text-xl font-bold text-slate-900"
                    >
                      {group.title}
                    </h2>
                    <div className="space-y-3">
                      {group.items.map((faq) => (
                        <details
                          key={faq.question}
                          className="group rounded-xl border border-slate-200 bg-slate-50/50 p-4 open:bg-white"
                        >
                          <summary className="cursor-pointer font-semibold text-slate-800 marker:text-orange-600">
                            {faq.question}
                          </summary>
                          <p className="mt-3 text-sm leading-relaxed text-slate-600">
                            {faq.answer}
                          </p>
                        </details>
                      ))}
                    </div>
                    {group.sources && (
                      <p className="mt-4 text-xs leading-relaxed text-slate-500">
                        Trusted reading:{' '}
                        {group.sources.map((source, sourceIndex) => (
                          <React.Fragment key={source.url}>
                            {sourceIndex > 0 && ' · '}
                            <a
                              className="font-medium text-orange-700 underline underline-offset-2 hover:text-orange-800"
                              href={source.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {source.label}
                            </a>
                          </React.Fragment>
                        ))}
                      </p>
                    )}
                  </section>
                ))}
              </div>
            </div>
          </section>
        )}
      </main>

      <footer className="animate-fade-in border-t border-slate-200 bg-slate-50 py-8">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-4 px-4 sm:flex-row sm:items-center sm:px-6 lg:px-8">
          <div>
            <address className="mt-0.5 text-xs not-italic text-slate-500">
              <p>Afienya ECG Under Bridge, Ghana</p>
              <p>Mon–Sat: 7:30 am–9:00 pm · Sun: 9:00 am–9:00 pm</p>
            </address>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs text-slate-500">© 2026 Netanya Pharmacy</span>
          </div>
        </div>
      </footer>

      {/* Slide-Over Cart & Retail Checkout Drawer */}
      {cartOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40 backdrop-blur-xs animate-overlay-in">
          <div
            className="flex h-full w-full max-w-md flex-col bg-white shadow-2xl animate-drawer-in"
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
                  {checkoutBusy ? 'Processing Payment...' : 'Pay for Retail Order'}
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
                      {selectedInfoItem.manufacturerName || 'Not listed'}
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
                    disabled={!selectedInfoItem.inStock}
                    onClick={() => {
                      addToCart(selectedInfoItem);
                      setSelectedInfoItem(null);
                    }}
                    className="rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700 disabled:bg-slate-200 disabled:text-slate-500"
                  >
                    {!selectedInfoItem.inStock ? 'Out of stock' : 'Add to Bag'}
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
