'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDollarSign, RefreshCw, Shield, Slash, Waypoints } from 'lucide-react';
import { formatPaise } from '@/domain/money';

type PassportRecord = { passportId: string; status: string; passport: { agentDisplayName: string } };
type AuthoritySnapshot = {
  mode: 'DISABLED' | 'SIMULATED' | 'DRUNIX';
  label: string;
  networkConnected: boolean;
  message?: string;
  mandate?: {
    mandateId: string; status: 'ACTIVE' | 'REVOKED'; aggregateCapPaise: number; perTransactionCapPaise: number;
    maximumUsageCount: number; activeUsageCount: number; reservedPaise: number; settledPaise: number;
    currency: string; paymentAdapterMode: 'MOCK' | 'RAZORPAY_TEST'; policyVersion: number; ownerMsp: string;
  };
  reservations?: Array<{
    reservationId: string; requestId: string; paymentAttemptId: string; participantMsp: string; executorIdentity: string;
    amountPaise: number; currency: string; status: string; reserveTransactionId: string;
    dispatchTransactionId?: string; outcomeTransactionId?: string; evidenceCommitment?: string;
  }>;
  paymentOperations?: Array<{
    intentId: string; reservationId: string; ledgerState: string; paymentState: string; dispatchState: string;
    reserveTransactionId: string | null; dispatchTransactionId: string | null; outcomeTransactionId: string | null;
    validationCode: string | null; lastError: string | null;
  }>;
};

function parsePaise(value: string, field: string): number {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`${field} must use rupees with at most two decimal places`);
  const whole = Number(match[1]);
  const fraction = Number((match[2] || '').padEnd(2, '0'));
  const amount = whole * 100 + fraction;
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`${field} must be a positive safe amount`);
  return amount;
}

function paymentStateForLedgerStatus(status: string): string {
  switch (status) {
    case 'RESERVED': return 'Not dispatched; amount is held';
    case 'DISPATCHING': return 'Dispatch claimed; provider outcome pending';
    case 'UNKNOWN': return 'Unknown; reconcile before reuse';
    case 'SETTLED': return 'Success recorded by verifier';
    case 'RELEASED': return 'Definitive failure recorded; hold released';
    default: return 'No payment outcome recorded';
  }
}

const badge = (value: string) => {
  if (['ACTIVE', 'SETTLED', 'RELEASED', 'SUCCEEDED'].includes(value)) return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (['UNKNOWN', 'DISPATCHING', 'OUTCOME_UNKNOWN', 'RESERVE_UNKNOWN', 'DISPATCH_UNKNOWN'].includes(value)) return 'bg-amber-50 text-amber-800 border-amber-200';
  if (['REVOKED', 'FAILED_DEFINITIVE', 'RESERVE_REJECTED'].includes(value)) return 'bg-rose-50 text-rose-700 border-rose-200';
  return 'bg-slate-100 text-slate-700 border-slate-200';
};

export default function SharedAuthorityPage() {
  const [snapshot, setSnapshot] = useState<AuthoritySnapshot | null>(null);
  const [passports, setPassports] = useState<PassportRecord[]>([]);
  const [passportId, setPassportId] = useState('');
  const [aggregate, setAggregate] = useState('5000');
  const [perTransaction, setPerTransaction] = useState('3000');
  const [usageCount, setUsageCount] = useState('10');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    const [authorityResponse, passportsResponse] = await Promise.all([fetch('/api/shared-authority'), fetch('/api/passports')]);
    const authorityData = await authorityResponse.json();
    const passportData = passportsResponse.ok ? await passportsResponse.json() : { passports: [] };
    if (!authorityResponse.ok) throw new Error(authorityData.message || 'Drunix state query failed; no current ledger state is shown');
    setSnapshot(authorityData);
    setPassports(passportData.passports || []);
    if (!passportId) setPassportId((passportData.passports || []).find((item: PassportRecord) => item.status === 'ACTIVE')?.passportId || '');
  }, [passportId]);

  useEffect(() => { refresh().catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to load shared authority state')); }, [refresh]);

  const operations = useMemo(() => new Map((snapshot?.paymentOperations || []).map((item) => [item.reservationId, item])), [snapshot]);
  const availablePaise = snapshot?.mandate ? snapshot.mandate.aggregateCapPaise - snapshot.mandate.reservedPaise - snapshot.mandate.settledPaise : 0;

  const issueMandate = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch('/api/shared-authority/mandate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        passportId, aggregateCapPaise: parsePaise(aggregate, 'Shared allowance'), perTransactionCapPaise: parsePaise(perTransaction, 'Per-purchase cap'), maximumUsageCount: Number(usageCount),
      }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Mandate issue did not commit');
      setNotice(`Mandate is committed by Drunix in transaction ${data.transactionId}.`);
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Mandate issue failed'); }
    finally { setBusy(false); }
  };

  const revoke = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch('/api/shared-authority/revoke', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Revocation is not confirmed');
      setNotice(`Future reservations are blocked after committed transaction ${data.transactionId}. Existing reservations remain held and may reconcile.`);
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Revocation failed'); }
    finally { setBusy(false); }
  };

  const reconcile = async (intentId: string) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/intents/${intentId}/reconcile`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Provider reconciliation failed');
      setNotice(data.message || 'Reconciliation queried the existing provider attempt. An unknown result still holds the allowance.');
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Reconciliation failed'); }
    finally { setBusy(false); }
  };

  const resumeBeforeProviderCall = async (intentId: string) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/intents/${intentId}/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fault_injection: 'NONE' }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Shared ledger gate could not be resumed');
      setNotice(data.result?.message || 'The original intent passed the current gates and resumed through Drunix.');
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to resume the ledger gate'); }
    finally { setBusy(false); }
  };

  return <div className="mx-auto max-w-6xl space-y-6">
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-slate-900"><Waypoints className="h-5 w-5 text-indigo-600" />Shared spending authority</h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600">Independent BoundPay services reserve the same Authority Passport allowance through Drunix. A payment request is sent only after a VALID reservation commit and a queried, committed dispatch claim.</p>
        </div>
        <button onClick={() => refresh().catch((reason) => setError(reason instanceof Error ? reason.message : 'Refresh failed'))} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"><RefreshCw className="h-3.5 w-3.5" />Refresh ledger</button>
      </div>
      <div className="mt-4 flex flex-wrap gap-2 text-[11px] font-semibold">
        <span className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-indigo-800">{snapshot?.label || 'SHARED AUTHORITY CHECKING…'}</span>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-slate-700">Payment provider is configured separately</span>
      </div>
      {snapshot && snapshot.mode !== 'DRUNIX' && <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{snapshot.message} This mode cannot claim network-backed authorization.</p>}
      {error && <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
      {notice && <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</p>}
    </section>

    {snapshot?.mandate ? <>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Shared allowance', formatPaise(snapshot.mandate.aggregateCapPaise)],
          ['Reserved', formatPaise(snapshot.mandate.reservedPaise)],
          ['Confirmed', formatPaise(snapshot.mandate.settledPaise)],
          ['Still available', formatPaise(availablePaise)],
        ].map(([label, value]) => <div key={label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs"><div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 text-lg font-bold text-slate-900">{value}</div></div>)}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="font-semibold text-slate-900">Mandate {snapshot.mandate.mandateId}</h2><p className="mt-1 text-xs text-slate-500">Per-purchase cap {formatPaise(snapshot.mandate.perTransactionCapPaise)} · {snapshot.mandate.activeUsageCount}/{snapshot.mandate.maximumUsageCount} uses · Passport payment mode {snapshot.mandate.paymentAdapterMode} · deterministic policy version {snapshot.mandate.policyVersion}</p></div>
          <div className="flex items-center gap-2"><span className={`rounded-full border px-3 py-1 text-[11px] font-bold ${badge(snapshot.mandate.status)}`}>{snapshot.mandate.status}</span>{snapshot.mandate.status === 'ACTIVE' && <button disabled={busy} onClick={revoke} className="rounded-lg border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 disabled:opacity-50"><Slash className="mr-1 inline h-3.5 w-3.5" />Revoke future authority</button>}</div>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
        <div className="border-b border-slate-100 px-5 py-4"><h2 className="font-semibold text-slate-900">Shared reservations</h2><p className="mt-1 text-xs text-slate-500">Unknown means the provider may have accepted the request. Its amount remains reserved; reconcile the same provider attempt before taking another action.</p></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left text-xs"><thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500"><tr><th className="px-5 py-3">Reservation / participant</th><th className="px-4 py-3">Amount</th><th className="px-4 py-3">Ledger state</th><th className="px-4 py-3">Payment state</th><th className="px-4 py-3">Commit evidence</th><th className="px-4 py-3">Action</th></tr></thead><tbody className="divide-y divide-slate-100">
          {(snapshot.reservations || []).map((reservation) => { const operation = operations.get(reservation.reservationId); return <tr key={reservation.reservationId}>
            <td className="px-5 py-3"><div className="font-mono text-slate-800">{reservation.reservationId}</div><div className="mt-1 text-slate-500">{reservation.participantMsp} · {reservation.executorIdentity.slice(0, 42)}</div></td>
            <td className="px-4 py-3 font-semibold text-slate-800">{formatPaise(reservation.amountPaise)}</td>
            <td className="px-4 py-3"><span className={`rounded-full border px-2 py-1 text-[10px] font-bold ${badge(reservation.status)}`}>{reservation.status}</span></td>
            <td className="px-4 py-3"><div className="font-semibold text-slate-800">{operation?.paymentState || paymentStateForLedgerStatus(reservation.status)}</div>{!operation && <div className="mt-1 text-slate-500">From shared ledger state</div>}{operation?.lastError && <div className="mt-1 max-w-48 truncate text-amber-700" title={operation.lastError}>{operation.lastError}</div>}</td>
            <td className="px-4 py-3 font-mono text-[10px] text-slate-600"><div>reserve {reservation.reserveTransactionId}</div>{reservation.dispatchTransactionId && <div>dispatch {reservation.dispatchTransactionId}</div>}{(reservation.outcomeTransactionId || operation?.outcomeTransactionId) && <div>outcome {reservation.outcomeTransactionId || operation?.outcomeTransactionId}</div>}{operation?.validationCode && <div>validation {operation.validationCode}</div>}</td>
            <td className="px-4 py-3">{operation && operation.dispatchState === 'NOT_SENT'
              ? <button disabled={busy} onClick={() => resumeBeforeProviderCall(operation.intentId)} className="rounded-lg border border-indigo-200 px-2.5 py-1.5 font-semibold text-indigo-700 disabled:opacity-50">Retry ledger gate</button>
              : operation && !['SETTLED', 'RELEASED'].includes(operation.ledgerState) && (['UNKNOWN', 'OUTCOME_UNKNOWN', 'DISPATCHING', 'ORDER_CREATED', 'SUCCEEDED', 'FAILED_DEFINITIVE'].includes(operation.paymentState) || ['OUTCOME_UNKNOWN', 'UNKNOWN', 'DISPATCH_UNKNOWN'].includes(operation.ledgerState))
                ? <button disabled={busy} onClick={() => reconcile(operation.intentId)} className="rounded-lg border border-slate-200 px-2.5 py-1.5 font-semibold text-slate-700 disabled:opacity-50">Reconcile</button>
                : null}</td>
          </tr>; })}
          {(snapshot.reservations || []).length === 0 && <tr><td colSpan={6} className="px-5 py-8 text-center text-slate-500">No shared reservations yet.</td></tr>}
        </tbody></table></div>
      </section>
    </> : snapshot?.mode === 'DRUNIX' && <section className="grid gap-5 lg:grid-cols-[1fr_1.2fr]">
      <form onSubmit={issueMandate} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <h2 className="flex items-center gap-2 font-semibold text-slate-900"><Shield className="h-4 w-4 text-indigo-600" />Issue shared mandate</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">The allowance and purchase scope are capped by the signed Passport and current BoundPay policy. Approval requirements continue to apply to every purchase.</p>
        <label className="mt-4 block text-xs font-semibold text-slate-700">Active Authority Passport<select required value={passportId} onChange={(event) => setPassportId(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"><option value="">Choose a Passport</option>{passports.filter((item) => item.status === 'ACTIVE').map((item) => <option key={item.passportId} value={item.passportId}>{item.passport.agentDisplayName} · {item.passportId}</option>)}</select></label>
        <div className="mt-3 grid grid-cols-2 gap-3"><label className="text-xs font-semibold text-slate-700">Allowance (₹)<input value={aggregate} onChange={(event) => setAggregate(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" /></label><label className="text-xs font-semibold text-slate-700">Per purchase (₹)<input value={perTransaction} onChange={(event) => setPerTransaction(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" /></label></div>
        <label className="mt-3 block text-xs font-semibold text-slate-700">Maximum uses<input type="number" min="1" max="100000" value={usageCount} onChange={(event) => setUsageCount(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" /></label>
        <button disabled={busy || !passportId} className="mt-4 w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-indigo-500 disabled:opacity-50">Commit mandate to Drunix</button>
      </form>
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs"><h2 className="flex items-center gap-2 font-semibold text-slate-900"><CircleDollarSign className="h-4 w-4 text-emerald-600" />Before first use</h2><ul className="mt-3 space-y-3 text-xs leading-relaxed text-slate-600"><li>Two services use different MSP certificates and separate local database/outbox files.</li><li>Each reserve changes one shared mandate budget key. Drunix validates concurrent writes before either payment request can be sent.</li><li>Both the reservation and the one-time dispatch claim need a VALID ledger commit and matching state readback before payment dispatch. Endorsement or submission does not suffice.</li><li>A provider timeout retains the amount. A restart never resends an uncertain create-order request.</li><li>Payment mode is independent: MOCK is synthetic; RAZORPAY_TEST is a provider sandbox; neither label implies a live bank transfer.</li></ul><div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900"><AlertTriangle className="mr-1 inline h-3.5 w-3.5" />Revocation blocks new ledger reservations after its commit. Reservations that committed first remain reserved; revocation does not cancel them or an in-flight provider payment.</div></div>
    </section>}
  </div>;
}
