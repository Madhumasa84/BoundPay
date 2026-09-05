'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Copy, KeyRound, LockKeyhole, Plus, Shield, XCircle } from 'lucide-react';
import { formatPaise } from '@/domain/money';

type PassportRecord = any;

const defaultExpiry = () => {
  const date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 16);
};

/**
 * Display inputs are decimal rupees, but the request boundary is integer
 * paise.  Parse text rather than using floating-point multiplication so an
 * authority constraint can never be rounded into a different value.
 */
function rupeeTextToPaise(value: string, field: string): number {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`${field} must be a non-negative rupee amount with at most two decimal places`);
  const whole = Number(match[1]);
  const fraction = Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(whole) || whole > Math.floor((Number.MAX_SAFE_INTEGER - fraction) / 100)) {
    throw new Error(`${field} exceeds the safe integer paise range`);
  }
  return whole * 100 + fraction;
}

export default function PassportsPage() {
  const [passports, setPassports] = useState<PassportRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [agentId, setAgentId] = useState('officebot');
  const [agentDisplayName, setAgentDisplayName] = useState('OfficeBot');
  const [merchants, setMerchants] = useState('demo_store');
  const [categories, setCategories] = useState('electronics, books');
  const [maximumAmount, setMaximumAmount] = useState('4000');
  const [cumulativeBudget, setCumulativeBudget] = useState('15000');
  const [approvalThreshold, setApprovalThreshold] = useState('3000');
  const [maximumUsageCount, setMaximumUsageCount] = useState(10);
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);

  const fetchPassports = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/passports');
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Unable to load authority passports');
      setPassports(data.passports || []);
    } catch (err: any) { setError(err.message || 'Unable to load authority passports'); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchPassports(); }, []);

  const createPassport = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true); setError(null); setMessage(null);
    try {
      const response = await fetch('/api/passports', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId, agentDisplayName,
          allowedMerchantIds: merchants.split(',').map((value) => value.trim()).filter(Boolean),
          allowedCategories: categories.split(',').map((value) => value.trim()).filter(Boolean),
          maximumAmountPerTransactionPaise: rupeeTextToPaise(maximumAmount, 'Maximum transaction amount'),
          cumulativeBudgetPaise: rupeeTextToPaise(cumulativeBudget, 'Cumulative budget'),
          approvalRequiredAbovePaise: rupeeTextToPaise(approvalThreshold, 'Approval threshold'),
          expiresAt: new Date(expiresAt).toISOString(),
          maximumUsageCount,
          idempotencyKey: `passport-${agentId}-${Math.round(new Date(expiresAt).getTime() / 1000)}`,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Unable to issue authority passport');
      setMessage(`Signed passport issued for ${data.passport.passport.agentDisplayName}.`);
      setShowCreate(false);
      await fetchPassports();
    } catch (err: any) { setError(err.message || 'Unable to issue authority passport'); }
    finally { setSaving(false); }
  };

  const revoke = async (passport: PassportRecord) => {
    setError(null); setMessage(null);
    try {
      const response = await fetch(`/api/passports/${passport.passportId}/revoke`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Unable to revoke passport');
      setMessage('Passport revoked durably. Future authorization and execution will fail closed.');
      await fetchPassports();
    } catch (err: any) { setError(err.message || 'Unable to revoke passport'); }
  };

  const copyToken = async (token: string, passportId: string) => {
    try { await navigator.clipboard.writeText(token); setCopied(passportId); setTimeout(() => setCopied(null), 1600); }
    catch { setError('Clipboard access was unavailable; use the export control instead.'); }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col gap-4 rounded-2xl border border-slate-200/90 bg-white p-6 shadow-xs sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2.5 text-lg font-bold text-slate-900">
            <Shield className="h-5 w-5 text-indigo-600" />
            <span>Authority Passports</span>
          </h1>
          <p className="mt-1 max-w-2xl text-xs text-slate-500 leading-relaxed">
            Signed, revocable mandates that constrain what an AI agent may propose. A passport never bypasses current server policy, exact approval, or atomic budget reservation.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/shop" className="rounded-xl border border-slate-200 px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 active:scale-[0.99] transition shadow-2xs">
            Back to Shop
          </Link>
          <button
            type="button"
            onClick={() => setShowCreate((value) => !value)}
            className="flex items-center gap-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:scale-[0.99] px-3.5 py-2 text-xs font-semibold text-white transition shadow-sm shadow-indigo-500/20 cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Create passport</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-200/90 bg-white p-4 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Server-trusted</div>
          <div className="mt-1.5 text-xs text-slate-700 leading-relaxed">Catalog price, merchant, category, policy, and ledger state.</div>
        </div>
        <div className="rounded-2xl border border-slate-200/90 bg-white p-4 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600">Cryptographically signed</div>
          <div className="mt-1.5 text-xs text-slate-700 leading-relaxed">Ed25519 / EdDSA payload with issuer, audience, key ID, and expiry.</div>
        </div>
        <div className="rounded-2xl border border-slate-200/90 bg-white p-4 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-600">Not a login token</div>
          <div className="mt-1.5 text-xs text-slate-700 leading-relaxed">Possessing a passport does not grant access to another operator’s intents.</div>
        </div>
      </div>

      {message && (
        <div role="status" className="rounded-xl border border-emerald-200/90 bg-emerald-50/80 p-3.5 text-xs font-medium text-emerald-950 flex items-center gap-2 shadow-2xs">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{message}</span>
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-xl border border-rose-200/90 bg-rose-50/80 p-3.5 text-xs font-medium text-rose-950 flex items-center gap-2 shadow-2xs">
          <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {showCreate && (
        <form onSubmit={createPassport} className="space-y-4 rounded-2xl border border-slate-200/90 bg-white p-6 shadow-xs" aria-labelledby="create-passport-heading">
          <div className="border-b border-slate-100 pb-3">
            <h2 id="create-passport-heading" className="text-xs font-bold uppercase tracking-wider text-slate-900">Issue a new signed passport</h2>
            <p className="mt-0.5 text-xs text-slate-500">All money fields are entered in rupees here and converted to integer paise before the server receives them. Enforcement timestamps are canonical UTC.</p>
          </div>
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <label className="text-xs font-semibold text-slate-700">
              Agent ID
              <input required value={agentId} onChange={(e) => setAgentId(e.target.value)} className="mt-1.5 block w-full rounded-xl border border-slate-200/90 px-3 py-2 font-mono text-xs text-slate-900 focus:ring-2 focus:ring-indigo-500/40 bg-white" />
            </label>
            <label className="text-xs font-semibold text-slate-700">
              Agent display name
              <input required value={agentDisplayName} onChange={(e) => setAgentDisplayName(e.target.value)} className="mt-1.5 block w-full rounded-xl border border-slate-200/90 px-3 py-2 text-xs text-slate-900 focus:ring-2 focus:ring-indigo-500/40 bg-white" />
            </label>
            <label className="text-xs font-semibold text-slate-700">
              Allowed merchant IDs
              <input required value={merchants} onChange={(e) => setMerchants(e.target.value)} className="mt-1.5 block w-full rounded-xl border border-slate-200/90 px-3 py-2 font-mono text-xs text-slate-900 focus:ring-2 focus:ring-indigo-500/40 bg-white" />
            </label>
            <label className="text-xs font-semibold text-slate-700">
              Allowed categories
              <input required value={categories} onChange={(e) => setCategories(e.target.value)} className="mt-1.5 block w-full rounded-xl border border-slate-200/90 px-3 py-2 font-mono text-xs text-slate-900 focus:ring-2 focus:ring-indigo-500/40 bg-white" />
            </label>
          </div>
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-4">
            <label className="text-xs font-semibold text-slate-700">
              Max / transaction (₹)
              <input type="text" inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" required value={maximumAmount} onChange={(e) => setMaximumAmount(e.target.value)} className="mt-1.5 block w-full rounded-xl border border-slate-200/90 px-3 py-2 font-mono text-xs text-slate-900 focus:ring-2 focus:ring-indigo-500/40 bg-white font-semibold" />
            </label>
            <label className="text-xs font-semibold text-slate-700">
              Cumulative budget (₹)
              <input type="text" inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" required value={cumulativeBudget} onChange={(e) => setCumulativeBudget(e.target.value)} className="mt-1.5 block w-full rounded-xl border border-slate-200/90 px-3 py-2 font-mono text-xs text-slate-900 focus:ring-2 focus:ring-indigo-500/40 bg-white font-semibold" />
            </label>
            <label className="text-xs font-semibold text-slate-700">
              Approval above (₹)
              <input type="text" inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" required value={approvalThreshold} onChange={(e) => setApprovalThreshold(e.target.value)} className="mt-1.5 block w-full rounded-xl border border-slate-200/90 px-3 py-2 font-mono text-xs text-slate-900 focus:ring-2 focus:ring-indigo-500/40 bg-white font-semibold" />
            </label>
            <label className="text-xs font-semibold text-slate-700">
              Maximum usages
              <input type="number" min={1} required value={maximumUsageCount} onChange={(e) => setMaximumUsageCount(Number(e.target.value) || 0)} className="mt-1.5 block w-full rounded-xl border border-slate-200/90 px-3 py-2 font-mono text-xs text-slate-900 focus:ring-2 focus:ring-indigo-500/40 bg-white" />
            </label>
          </div>
          <div className="flex flex-col gap-3.5 sm:flex-row sm:items-end pt-2 border-t border-slate-100">
            <label className="text-xs font-semibold text-slate-700 flex-1">
              Expires (local display; sent as UTC)
              <input type="datetime-local" required value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="mt-1.5 block w-full rounded-xl border border-slate-200/90 px-3 py-2 font-mono text-xs text-slate-900 focus:ring-2 focus:ring-indigo-500/40 bg-white" />
            </label>
            <button type="submit" disabled={saving} className="rounded-xl bg-indigo-600 hover:bg-indigo-500 active:scale-[0.99] px-5 py-2.5 text-xs font-semibold text-white transition shadow-sm shadow-indigo-500/20 disabled:opacity-50 cursor-pointer">
              {saving ? 'Signing…' : 'Issue signed passport'}
            </button>
          </div>
        </form>
      )}

      <section className="space-y-3.5" aria-labelledby="passport-list-heading">
        <div className="flex items-center justify-between">
          <h2 id="passport-list-heading" className="text-xs font-bold uppercase tracking-wider text-slate-900">Owned passports</h2>
          <span className="text-[11px] text-slate-400 font-mono">{passports.length} total</span>
        </div>
        {loading ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-xs text-slate-400">Loading signed authority records…</div>
        ) : passports.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-10 text-center text-xs text-slate-400">No passports yet. Issue one to bind an AI agent to a purchase intent.</div>
        ) : (
          passports.map((record) => (
            <article key={record.passportId} className="space-y-3.5 rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between border-b border-slate-100 pb-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-bold text-slate-900 text-sm">{record.passport.agentDisplayName}</h3>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border ${record.status === 'ACTIVE' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : record.status === 'REVOKED' ? 'bg-rose-50 border-rose-200 text-rose-800' : 'bg-slate-100 border-slate-200 text-slate-700'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${record.status === 'ACTIVE' ? 'bg-emerald-500' : record.status === 'REVOKED' ? 'bg-rose-500' : 'bg-slate-400'}`} />
                      {record.status}
                    </span>
                    <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-600">kid: {record.passport.keyId}</span>
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-slate-400">
                    {record.passportId} · agent: {record.passport.agentId} · policy v{record.passport.policyVersion}
                  </div>
                </div>
                {record.status === 'ACTIVE' && (
                  <button type="button" onClick={() => revoke(record)} className="flex items-center justify-center gap-1.5 rounded-xl border border-rose-200 hover:bg-rose-50 active:scale-[0.99] px-3 py-1.5 text-xs font-semibold text-rose-700 transition cursor-pointer shadow-2xs">
                    <XCircle className="h-3.5 w-3.5" />
                    <span>Revoke passport</span>
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
                <div className="rounded-xl border border-slate-200/80 bg-slate-50/50 p-2.5">
                  <div className="text-[11px] text-slate-400 font-medium">Per transaction</div>
                  <div className="font-mono font-bold text-slate-900 mt-0.5">{formatPaise(record.passport.maximumAmountPerTransactionPaise)}</div>
                </div>
                <div className="rounded-xl border border-slate-200/80 bg-slate-50/50 p-2.5">
                  <div className="text-[11px] text-slate-400 font-medium">Cumulative budget</div>
                  <div className="font-mono font-bold text-slate-900 mt-0.5">{formatPaise(record.passport.cumulativeBudgetPaise)}</div>
                </div>
                <div className="rounded-xl border border-slate-200/80 bg-slate-50/50 p-2.5">
                  <div className="text-[11px] text-slate-400 font-medium">Committed</div>
                  <div className="font-mono font-bold text-slate-900 mt-0.5">{formatPaise(record.consumption.totalCommittedPaise)}</div>
                </div>
                <div className="rounded-xl border border-slate-200/80 bg-slate-50/50 p-2.5">
                  <div className="text-[11px] text-slate-400 font-medium">Remaining</div>
                  <div className="font-mono font-bold text-indigo-700 mt-0.5">{formatPaise(record.consumption.remainingBudgetPaise)}</div>
                </div>
                <div className="rounded-xl border border-slate-200/80 bg-slate-50/50 p-2.5">
                  <div className="text-[11px] text-slate-400 font-medium">Usage allowance</div>
                  <div className="font-mono font-bold text-slate-900 mt-0.5">{record.consumption.remainingUsageCount} / {record.passport.maximumUsageCount}</div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 text-xs pt-1">
                <button type="button" onClick={() => copyToken(record.signedToken, record.passportId)} className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-800 hover:bg-slate-50 active:scale-[0.99] transition shadow-2xs cursor-pointer">
                  <Copy className="h-3.5 w-3.5 text-slate-500" />
                  <span>{copied === record.passportId ? 'Copied' : 'Copy signed passport'}</span>
                </button>
                <a href={`data:application/jwt;charset=utf-8,${encodeURIComponent(record.signedToken)}`} download={`${record.passportId}.jwt`} className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 active:scale-[0.99] transition shadow-2xs">
                  <KeyRound className="h-3.5 w-3.5 text-slate-500" />
                  <span>Export compact JWS</span>
                </a>
              </div>
              <details className="pt-1">
                <summary className="cursor-pointer text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 select-none">
                  View exact signed constraints
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-slate-950 p-3.5 text-[11px] font-mono text-slate-300 border border-slate-800 shadow-inner">
                  {JSON.stringify(record.passport, null, 2)}
                </pre>
              </details>
            </article>
          ))
        )}
      </section>

      <div className="rounded-2xl border border-slate-200/90 bg-slate-50 p-4 text-xs text-slate-600 flex items-start gap-2.5 shadow-2xs">
        <LockKeyhole className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
        <div className="leading-relaxed">
          <strong className="text-slate-900 font-semibold">Proof limitation:</strong> the signature proves that configured BoundPay authority signed the displayed contents and that they were not altered. It does not independently prove database completeness, signing-host integrity, or payment settlement at a bank/provider.
        </div>
      </div>
    </div>
  );
}
