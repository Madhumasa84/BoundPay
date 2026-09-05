'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ShoppingBag, ShieldCheck, Activity, KeyRound, LogOut, Lock, AlertTriangle } from 'lucide-react';

export function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const [operator, setOperator] = useState<{ id: string; username: string } | null>(null);
  const [paymentMode, setPaymentMode] = useState<'MOCK' | 'RAZORPAY_TEST' | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && data.operator) {
          setOperator(data.operator);
          fetch('/api/runtime')
            .then((res) => (res.ok ? res.json() : null))
            .then((runtime) => setPaymentMode(runtime?.paymentMode || null))
            .catch(() => setPaymentMode(null));
        } else {
          setOperator(null);
          if (['/shop', '/policy', '/activity', '/passports'].includes(pathname)) router.replace('/login');
        }
      })
      .catch(() => setOperator(null));
  }, [pathname, router]);

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setOperator(null);
    router.push('/login');
  };

  const navLinks = [
    { href: '/shop', label: 'Shop', icon: ShoppingBag },
    { href: '/policy', label: 'Policy', icon: ShieldCheck },
    { href: '/activity', label: 'Activity', icon: Activity },
    { href: '/passports', label: 'Passports', icon: KeyRound },
  ];

  return (
    <header className="bg-slate-950/90 backdrop-blur-md border-b border-slate-800/80 text-white sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center space-x-6">
            <Link href="/shop" className="flex items-center space-x-3 group">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-white font-black text-sm shadow-md shadow-blue-500/20 group-hover:scale-105 transition-transform">
                BP
              </div>
              <div className="flex items-center space-x-2.5">
                <span className="font-bold text-white text-base tracking-tight">
                  BoundPay
                </span>
                <span className="text-[10px] tracking-wide bg-slate-800/90 text-slate-300 font-medium px-2 py-0.5 rounded-full border border-slate-700/80">
                  Phase 4 Authority Passports
                </span>
              </div>
            </Link>

            <nav className="hidden md:flex items-center space-x-1 pl-2">
              {navLinks.map((link) => {
                const Icon = link.icon;
                const isActive = pathname === link.href;
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      isActive
                        ? 'bg-slate-800/90 text-white shadow-xs border border-slate-700/70 font-semibold'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                    }`}
                  >
                    <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-blue-400' : 'text-slate-400'}`} />
                    <span>{link.label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center space-x-3">
            <div className="hidden sm:inline-flex items-center space-x-2 bg-slate-900/90 px-3 py-1 rounded-full text-xs text-slate-300 border border-slate-800 shadow-xs">
              <span className={`w-1.5 h-1.5 rounded-full ${paymentMode === 'RAZORPAY_TEST' ? 'bg-emerald-400 animate-pulse' : 'bg-blue-400'}`} />
              <span className="font-mono text-[11px] tracking-tight">{paymentMode === 'RAZORPAY_TEST' ? 'RAZORPAY TEST MODE' : paymentMode === 'MOCK' ? 'MOCK PAYMENT MODE' : 'MODE CHECKING…'}</span>
            </div>

            {operator ? (
              <div className="flex items-center space-x-3 pl-1 border-l border-slate-800">
                <div className="flex items-center space-x-2">
                  <div className="w-7 h-7 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 font-semibold text-xs">
                    {operator.username.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="hidden sm:block text-left">
                    <div className="text-[10px] text-slate-400 font-medium leading-none">Operator</div>
                    <div className="text-xs font-semibold text-slate-200 leading-tight">{operator.username}</div>
                  </div>
                </div>
                <button
                  onClick={handleLogout}
                  className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-red-400 hover:bg-red-950/20 border border-slate-800 hover:border-red-900/40 transition-all"
                  title="Log out"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Logout</span>
                </button>
              </div>
            ) : (
              <Link
                href="/login"
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-sm shadow-blue-600/20 transition-all"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Operator Login</span>
              </Link>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
