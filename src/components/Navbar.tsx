'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ShoppingBag, ShieldCheck, Activity, LogOut, Lock, AlertTriangle } from 'lucide-react';

export function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const [operator, setOperator] = useState<{ id: string; username: string } | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && data.operator) {
          setOperator(data.operator);
        } else {
          setOperator(null);
        }
      })
      .catch(() => setOperator(null));
  }, [pathname]);

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setOperator(null);
    router.push('/login');
  };

  const navLinks = [
    { href: '/shop', label: 'Shop', icon: ShoppingBag },
    { href: '/policy', label: 'Policy', icon: ShieldCheck },
    { href: '/activity', label: 'Activity', icon: Activity },
  ];

  return (
    <header className="bg-slate-900 border-b border-slate-800 text-white sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center space-x-4">
            <Link href="/shop" className="flex items-center space-x-2">
              <span className="bg-blue-600 text-white font-bold px-2.5 py-1 rounded text-lg tracking-tight">
                BoundPay
              </span>
              <span className="text-xs uppercase tracking-wider bg-amber-500/20 text-amber-300 font-semibold px-2 py-0.5 rounded border border-amber-500/40">
                Phase 1 Prototype
              </span>
            </Link>

            <nav className="hidden md:flex space-x-1 ml-6">
              {navLinks.map((link) => {
                const Icon = link.icon;
                const isActive = pathname === link.href;
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`flex items-center space-x-1.5 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-blue-600/30 text-blue-300 border border-blue-500/40'
                        : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{link.label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center space-x-3">
            <div className="hidden sm:flex items-center space-x-1 bg-slate-800/80 px-2.5 py-1 rounded text-xs text-slate-300 border border-slate-700">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
              <span>MOCK PAYMENT ADAPTER ACTIVE</span>
            </div>

            {operator ? (
              <div className="flex items-center space-x-3">
                <div className="text-right hidden sm:block">
                  <div className="text-xs text-slate-400">Operator</div>
                  <div className="text-sm font-semibold text-white">{operator.username}</div>
                </div>
                <button
                  onClick={handleLogout}
                  className="flex items-center space-x-1 px-3 py-1.5 rounded text-xs font-medium bg-slate-800 hover:bg-red-950/50 hover:text-red-300 border border-slate-700 hover:border-red-800 transition-colors"
                  title="Log out"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Logout</span>
                </button>
              </div>
            ) : (
              <Link
                href="/login"
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
              >
                <Lock className="w-4 h-4" />
                <span>Operator Login</span>
              </Link>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
