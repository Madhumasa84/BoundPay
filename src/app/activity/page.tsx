'use client';

import React, { useEffect, useState } from 'react';
import { Activity, Download, RefreshCw, FileText, CheckCircle, ArrowRight, ShieldAlert } from 'lucide-react';
import { formatPaise } from '@/domain/money';

export default function ActivityPage() {
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [filterType, setFilterType] = useState<string>('ALL');
  const [error, setError] = useState<string | null>(null);

  const fetchAuditEvents = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/audit?limit=100');
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Audit request failed');
      setEvents(data.events || []);
    } catch (e: any) {
      setError(`${e.message || 'Unable to load audit records'}. Check your session and use Refresh to retry.`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAuditEvents();
  }, []);

  const filteredEvents = filterType === 'ALL'
    ? events
    : events.filter((e) => e.event_type === filterType);

  const getEventBadge = (type: string) => {
    if (type.includes('CONFIRMED') || type.includes('APPROVED')) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-50 text-emerald-800 border border-emerald-200/80">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5" />
          {type}
        </span>
      );
    }
    if (type.includes('BLOCKED') || type.includes('DECLINED') || type.includes('FAILED')) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-rose-50 text-rose-800 border border-rose-200/80">
          <span className="w-1.5 h-1.5 rounded-full bg-rose-500 mr-1.5" />
          {type}
        </span>
      );
    }
    if (type.includes('RESERVED') || type.includes('PROPOSED')) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-blue-50 text-blue-800 border border-blue-200/80">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 mr-1.5" />
          {type}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-slate-100 text-slate-700 border border-slate-200/80">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400 mr-1.5" />
        {type}
      </span>
    );
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="bg-white p-6 rounded-2xl border border-slate-200/90 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-slate-900 flex items-center space-x-2.5">
            <Activity className="w-5 h-5 text-blue-600" />
            <span>Audit Trail & Activity Log</span>
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Chronological audit events recorded append-only through the application server.
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={fetchAuditEvents}
            disabled={loading}
            className="flex items-center space-x-1.5 px-3 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 active:scale-[0.99] text-slate-700 text-xs font-semibold transition cursor-pointer shadow-2xs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>

          <a
            href="/api/audit/export"
            download
            className="flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 active:scale-[0.99] text-white text-xs font-semibold shadow-sm shadow-blue-500/20 transition cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Audit JSON</span>
          </a>
        </div>
      </div>

      {/* Storage Architecture Notice */}
      <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/90 text-slate-800 text-xs flex items-start space-x-2.5 shadow-2xs">
        <ShieldAlert className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="leading-relaxed text-slate-600">
          <span className="font-semibold text-slate-800">Append-Only Audit Notice:</span> All events are recorded sequentially through the server application layer. This is an append-only application audit log, not an immutable cryptographic ledger (a database administrator with root access could still modify storage).
        </div>
      </div>

      {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50/80 p-3.5 text-xs text-rose-900 font-medium">{error}</div>}

      {/* Filter Toolbar */}
      <div className="flex items-center space-x-1.5 overflow-x-auto pb-1 text-xs">
        <span className="text-slate-400 font-semibold uppercase tracking-wider text-[11px] mr-1.5 shrink-0">Filter:</span>
        {['ALL', 'INTENT_PROPOSED', 'BUDGET_RESERVED', 'ORDER_CREATED', 'PAYMENT_CONFIRMED', 'INTENT_APPROVED', 'POLICY_UPDATED'].map((t) => (
          <button
            key={t}
            onClick={() => setFilterType(t)}
            className={`px-3 py-1 rounded-full font-medium text-xs transition cursor-pointer shrink-0 ${
              filterType === t
                ? 'bg-slate-900 text-white shadow-2xs font-semibold'
                : 'bg-white border border-slate-200/90 text-slate-600 hover:bg-slate-50 hover:text-slate-900'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Events Table / Feed */}
      <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs overflow-hidden">
        {filteredEvents.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-xs">
            {loading ? 'Loading audit records...' : 'No audit events found.'}
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredEvents.map((evt) => (
              <div key={evt.id} className="p-4 sm:p-5 hover:bg-slate-50/50 transition flex flex-col md:flex-row gap-3 sm:gap-4">
                {/* Left meta */}
                <div className="md:w-56 flex-shrink-0 text-xs space-y-1.5">
                  <div className="flex items-center space-x-2">
                    <span className="font-mono font-bold text-slate-400 text-[11px]">#{evt.id}</span>
                    {getEventBadge(evt.event_type)}
                  </div>
                  <div className="text-slate-500 font-mono text-[11px]">
                    {new Date(evt.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
                  </div>
                  {evt.operator_id && (
                    <div className="text-[11px] text-slate-400 truncate font-mono">
                      Op: {evt.operator_id}
                    </div>
                  )}
                </div>

                {/* Center details */}
                <div className="flex-1 text-xs space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {evt.intent_id && (
                      <span className="font-mono bg-slate-50 border border-slate-200/80 text-slate-700 px-2 py-0.5 rounded-lg text-[11px]">
                        Intent: {evt.intent_id.slice(0, 8)}...
                      </span>
                    )}
                    {evt.amount_paise != null && (
                      <span className="font-bold text-slate-900 bg-slate-50 border border-slate-200/80 px-2 py-0.5 rounded-lg text-[11px]">
                        {formatPaise(evt.amount_paise)} ({evt.amount_paise} paise)
                      </span>
                    )}
                    {evt.policy_version != null && (
                      <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full text-[10px] font-mono">
                        Policy v{evt.policy_version}
                      </span>
                    )}
                    {evt.state_before && evt.state_after && (
                      <div className="inline-flex items-center space-x-1.5 text-[11px] font-mono text-slate-600 bg-slate-50 border border-slate-200/60 px-2 py-0.5 rounded-lg">
                        <span className="text-slate-500">{evt.state_before}</span>
                        <ArrowRight className="w-3 h-3 text-slate-400" />
                        <span className="font-semibold text-slate-900">{evt.state_after}</span>
                      </div>
                    )}
                  </div>

                  {/* Structured Payload Preview */}
                  <details className="mt-1 group">
                    <summary className="text-[11px] text-slate-500 hover:text-blue-600 cursor-pointer font-mono select-none">
                      ▶ Payload Details
                    </summary>
                    <pre className="mt-2 p-3 rounded-xl bg-slate-950 text-slate-300 font-mono text-[11px] overflow-x-auto max-h-56 border border-slate-800 shadow-inner">
                      {JSON.stringify(evt.payload, null, 2)}
                    </pre>
                  </details>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
