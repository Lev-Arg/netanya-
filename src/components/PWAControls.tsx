import React, { useState } from 'react';
import { Download, Smartphone, WifiOff, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWA.ts';

export const PWAInstallButton: React.FC<{ variant?: 'compact' | 'button' }> = ({
  variant = 'button',
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className={
          variant === 'compact'
            ? 'inline-flex items-center gap-1.5 rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-semibold text-orange-700 hover:bg-orange-100 transition-colors whitespace-nowrap shrink-0 min-h-[40px]'
            : 'inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700 transition-colors whitespace-nowrap shrink-0 min-h-[40px]'
        }
      >
        <Download className="h-3.5 w-3.5" />
        Install Mobile App
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setShowGuide(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-orange-300 hover:text-orange-700 transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
      >
        <Smartphone className="h-3.5 w-3.5 text-orange-600" />
        {isIOS ? 'Install on iOS' : 'Mobile App'}
      </button>

      {showGuide && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-install-title"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 id="pwa-install-title" className="text-lg font-bold text-slate-900">
                  Install Netanya Pharmacy App
                </h3>
                <p className="mt-1 text-sm text-slate-600">
                  Quick access to your prescriptions, orders, and dose reminders.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-2.5 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
              {isIOS ? (
                <>
                  <p>
                    1. Tap <strong>Share</strong> in Safari.
                  </p>
                  <p>
                    2. Choose <strong>Add to Home Screen</strong>.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    1. Open your browser menu and select <strong>Install app</strong>.
                  </p>
                  <p>
                    2. Allow notifications in your account for dose and refill alerts.
                  </p>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="mt-5 w-full rounded-lg bg-orange-600 py-2.5 text-sm font-semibold text-white hover:bg-orange-700 transition-colors"
            >
              Got It
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-20 left-4 z-50 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2 text-xs font-semibold text-amber-900 shadow-sm md:bottom-4"
    >
      <WifiOff className="h-3.5 w-3.5 text-amber-700" />
      <span>Offline Mode · Cached medication schedules active</span>
    </div>
  );
};
