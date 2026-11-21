import { useCallback, useEffect, useState } from 'react';
import { AuthModal } from './components/AuthModal.tsx';
import { OwnerPortal } from './components/OwnerPortal.tsx';
import { PatientPortal } from './components/PatientPortal.tsx';
import { OfflineIndicator } from './components/PWAControls.tsx';
import { PublicStorefront } from './components/PublicStorefront.tsx';
import { StaffPortal } from './components/StaffPortal.tsx';
import { SupplierPortal } from './components/SupplierPortal.tsx';
import type { AuthUser, InventoryItem, PharmacyService } from './types.ts';
import { apiFetch, getStoredToken, setStoredToken, useRealtimeTopics } from './utils/api.ts';

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(getStoredToken());
  const [viewMode, setViewMode] = useState<'public' | 'portal'>('public');
  const [authModalOpen, setAuthModalOpen] = useState(false);

  const [catalogItems, setCatalogItems] = useState<InventoryItem[]>([]);
  const [services, setServices] = useState<PharmacyService[]>([]);
  const [acceptedPlans, setAcceptedPlans] = useState<
    Array<{ id: string; payerName: string; bin: string; pcn: string; groupPrefix: string }>
  >([]);
  const [catalogLoading, setCatalogLoading] = useState(true);

  const loadCatalog = useCallback(async () => {
    try {
      const data = await apiFetch<{
        items: InventoryItem[];
        services?: PharmacyService[];
        acceptedPlans: Array<{
          id: string;
          payerName: string;
          bin: string;
          pcn: string;
          groupPrefix: string;
        }>;
      }>('/api/public/catalog');
      setCatalogItems(data.items);
      setServices(data.services || []);
      setAcceptedPlans(data.acceptedPlans);
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    const existingToken = getStoredToken();
    if (!existingToken) return;
    apiFetch<{ user: AuthUser }>('/api/auth/me')
      .then((res) => {
        setUser(res.user);
        setToken(existingToken);
        setViewMode('portal');
      })
      .catch(() => {
        setStoredToken(null);
        setToken(null);
        setUser(null);
      });
  }, []);

  useRealtimeTopics(['inventory', 'services'], loadCatalog, token);

  const handleOpenAuth = () => {
    setAuthModalOpen(true);
  };

  const handleAuthenticated = (authedUser: AuthUser, newToken: string) => {
    setUser(authedUser);
    setToken(newToken);
    setViewMode('portal');
  };

  const handleLogout = () => {
    setStoredToken(null);
    setToken(null);
    setUser(null);
    setViewMode('public');
  };

  return (
    <>
      {viewMode === 'portal' && user && token ? (
        user.role === 'patient' ? (
          <PatientPortal
            user={user}
            token={token}
            onGoToStorefront={() => setViewMode('public')}
            onLogout={handleLogout}
          />
        ) : user.role === 'pharmacist' ? (
          <StaffPortal
            user={user}
            token={token}
            onGoToStorefront={() => setViewMode('public')}
            onLogout={handleLogout}
          />
        ) : user.role === 'supplier' ? (
          <SupplierPortal
            user={user}
            token={token}
            onGoToStorefront={() => setViewMode('public')}
            onLogout={handleLogout}
          />
        ) : (
          <OwnerPortal
            user={user}
            token={token}
            onGoToStorefront={() => setViewMode('public')}
            onLogout={handleLogout}
          />
        )
      ) : (
        <PublicStorefront
          items={catalogItems}
          services={services}
          acceptedPlans={acceptedPlans}
          loading={catalogLoading}
          user={user}
          onOpenAuth={handleOpenAuth}
          onEnterPortal={() => setViewMode('portal')}
          onOrderCompleted={loadCatalog}
        />
      )}

      <AuthModal
        isOpen={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        onAuthenticated={handleAuthenticated}
      />

      <OfflineIndicator />
    </>
  );
}
