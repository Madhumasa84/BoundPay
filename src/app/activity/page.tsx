'use client';

import React, { useEffect, useState } from 'react';
import { Activity, Download, RefreshCw, FileText, CheckCircle, ArrowRight, ShieldAlert } from 'lucide-react';
import { formatPaise } from '@/domain/money';

export default function ActivityPage() {
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [filterType, setFilterType] = useState<string>('ALL');

  const fetchAuditEvents = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/audit?limit=100');
      if (res.ok) {
        const data = await res.json();
        setEvents(data.events || []);
      }
    } catch (e) {
      console.error(e);
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
      return <span className="bg-emerald-100 text-emerald-800 border border-emerald-300 font-mono text-[10px] font-bold px-2 py-0.5 rounded">{type}</span>;
    }
    if (type.includes('BLOCKED') || type.includes('DECLINED') || type.includes('FAILED')) {
      return <span className="bg-red-100 text-red-800 border border-red-300 font-mono text-[10px] font-bold px-2 py-0.5 rounded">{type}</span>;
    }
    if (type.includes('RESERVED') || type.includes('PROPOSED')) {
      return <span className="bg-blue-100 text-blue-800 border border-blue-300 font-mono text-[10px] font-bold px-2 py-0.5 rounded">{type}</span>;
    }
    return <span className="bg-slate-100 text-slate-800 border border-slate-300 font-mono text-[10px] font-bold px-2 py-0.5 rounded">{type}</span>;
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center space-x-2">
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
            className="flex items-center space-x-1 px-3 py-2 rounded-md border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-medium transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>

          <a
            href="/api/audit/export"
            download
            className="flex items-center space-x-1.5 px-3.5 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-sm transition"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Audit JSON</span>
          </a>
        </div>
      </div>

      {/* Storage Architecture Notice */}
      <div className="p-3.5 rounded-xl bg-amber-50/70 border border-amber-200 text-amber-950 text-xs flex items-start space-x-2">
        <ShieldAlert className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
        <div>
          <span className="font-semibold">Append-Only Audit Notice:</span> All events are recorded sequentially through the server application layer. This is an append-only application audit log, not an immutable cryptographic ledger (a database administrator with root access could still modify storage).
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="flex items-center space-x-2 overflow-x-auto pb-1 text-xs">
        <span className="text-slate-500 font-semibold uppercase tracking-wider text-[11px] mr-1">Filter:</span>
        {['ALL', 'INTENT_PROPOSED', 'BUDGET_RESERVED', 'ORDER_CREATED', 'PAYMENT_CONFIRMED', 'INTENT_APPROVED', 'POLICY_UPDATED'].map((t) => (
          <button
            key={t}
            onClick={() => setFilterType(t)}
            className={`px-2.5 py-1 rounded-full font-medium transition ${
              filterType === t
                ? 'bg-slate-900 text-white'
                : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Events Table / Feed */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {filteredEvents.length === 0 ? (
          <div className="p-12 text-center text-slate-500 text-sm">
            {loading ? 'Loading audit records...' : 'No audit events found.'}
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredEvents.map((evt) => (
              <div key={evt.id} className="p-4 hover:bg-slate-50/60 transition flex flex-col md:flex-row gap-3">
                {/* Left meta */}
                <div className="md:w-52 flex-shrink-0 text-xs space-y-1">
                  <div className="flex items-center space-x-2">
                    <span className="font-mono font-bold text-slate-400">#{evt.id}</span>
                    {getEventBadge(evt.event_type)}
                  </div>
                  <div className="text-slate-500 font-mono text-[11px]">
                    {new Date(evt.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
                  </div>
                  {evt.operator_id && (
                    <div className="text-[10px] text-slate-400 truncate">
                      Op: {evt.operator_id}
                    </div>
                  )}
                </div>

                {/* Center details */}
                <div className="flex-1 text-xs space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    {evt.intent_id && (
                      <span className="font-mono bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded text-[11px]">
                        Intent: {evt.intent_id.slice(0, 8)}...
                      </span>
                    )}
                    {evt.amount_paise != null && (
                      <span className="font-bold text-slate-800">
                        {formatPaise(evt.amount_paise)} ({evt.amount_paise} paise)
                      </span>
                    )}
                    {evt.policy_version != null && (
                      <span className="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded text-[10px]">
                        Policy v{evt.policy_version}
                      </span>
                    )}
                    {evt.state_before && evt.state_after && (
                      <div className="inline-flex items-center space-x-1 text-[11px] font-mono text-slate-600">
                        <span className="text-slate-500">{evt.state_before}</span>
                        <ArrowRight className="w-3 h-3 text-slate-400" />
                        <span className="font-semibold text-slate-800">{evt.state_after}</span>
                      </div>
                    )}
                  </div>

                  {/* Structured Payload Preview */}
                  <details className="mt-1">
                    <summary className="text-[11px] text-blue-600 cursor-pointer hover:underline font-mono">
                      Payload Details
                    </summary>
                    <pre className="mt-1.5 p-2 rounded bg-slate-900 text-slate-200 font-mono text-[11px] overflow-x-auto max-h-48 border border-slate-800">
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
