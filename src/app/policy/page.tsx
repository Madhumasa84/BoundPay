'use client';

import React, { useEffect, useState } from 'react';
import { ShieldCheck, AlertCircle, CheckCircle, Info, Calendar, DollarSign, Lock } from 'lucide-react';
import { SpendingPolicy } from '@/domain/policy';
import { DailyBudgetUsage } from '@/services/policy.service';
import { formatPaise } from '@/domain/money';

export default function PolicyPage() {
  const [policy, setPolicy] = useState<SpendingPolicy | null>(null);
  const [usage, setUsage] = useState<DailyBudgetUsage | null>(null);

  // Form states
  const [maxTxRupees, setMaxTxRupees] = useState<number>(4000);
  const [dailyBudgetRupees, setDailyBudgetRupees] = useState<number>(5000);
  const [approvalThresholdRupees, setApprovalThresholdRupees] = useState<number>(2500);
  const [allowedCategoriesText, setAllowedCategoriesText] = useState<string>('electronics, books');
  const [approvedMerchant, setApprovedMerchant] = useState<string>('demo_store');
  const [allowSubscriptions, setAllowSubscriptions] = useState<boolean>(false);
  const [expiresAt, setExpiresAt] = useState<string>('');

  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const fetchPolicy = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/policy');
      if (res.ok) {
        const data = await res.json();
        setPolicy(data.policy);
        setUsage(data.usage);

        setMaxTxRupees(data.policy.max_transaction_amount_paise / 100);
        setDailyBudgetRupees(data.policy.daily_budget_paise / 100);
        setApprovalThresholdRupees(data.policy.approval_threshold_paise / 100);
        setAllowedCategoriesText(data.policy.allowed_categories.join(', '));
        setApprovedMerchant(data.policy.approved_merchant_id);
        setAllowSubscriptions(data.policy.allow_subscriptions);
        // Format for datetime-local input
        const d = new Date(data.policy.expires_at);
        setExpiresAt(d.toISOString().slice(0, 16));
      }
    } catch (e: any) {
      setFeedback({ type: 'error', message: e.message || 'Failed to load policy' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPolicy();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);

    try {
      const categories = allowedCategoriesText
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c.length > 0);

      const payload = {
        currency: 'INR',
        max_transaction_amount_paise: Math.round(maxTxRupees * 100),
        daily_budget_paise: Math.round(dailyBudgetRupees * 100),
        approval_threshold_paise: Math.round(approvalThresholdRupees * 100),
        allowed_categories: categories,
        approved_merchant_id: approvedMerchant,
        allow_subscriptions: allowSubscriptions,
        expires_at: new Date(expiresAt).toISOString(),
      };

      const res = await fetch('/api/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to update spending policy');
      }

      setPolicy(data.policy);
      setUsage(data.usage);
      setFeedback({
        type: 'success',
        message: `Policy successfully updated to Version ${data.policy.version}! Existing quotes and approvals will require re-authorization.`,
      });
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Error updating policy' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center space-x-2">
            <ShieldCheck className="w-6 h-6 text-blue-600" />
            <span>Spending Policy Authority</span>
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Server-side rules governing all agent proposals. Monotonically versioned and strictly enforced.
          </p>
        </div>
        {policy && (
          <div className="bg-slate-900 text-white px-3.5 py-1.5 rounded-lg text-xs font-mono flex items-center space-x-2">
            <span className="text-slate-400">Policy Version:</span>
            <span className="font-bold text-emerald-400 text-sm">v{policy.version}</span>
          </div>
        )}
      </div>

      {feedback && (
        <div
          className={`p-4 rounded-lg border text-sm flex items-start space-x-2.5 ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-900'
          }`}
        >
          {feedback.type === 'success' ? (
            <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          )}
          <span>{feedback.message}</span>
        </div>
      )}

      {/* Live Budget Usage Cards */}
      {usage && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Daily Budget
            </div>
            <div className="text-base font-bold text-slate-900 mt-1">
              {formatPaise(usage.dailyBudgetPaise)}
            </div>
            <div className="text-[10px] text-slate-400 font-mono">
              {usage.dailyBudgetPaise} paise
            </div>
          </div>

          <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600">
              Confirmed Spend Today
            </div>
            <div className="text-base font-bold text-emerald-700 mt-1">
              {formatPaise(usage.confirmedSpendTodayPaise)}
            </div>
            <div className="text-[10px] text-slate-400 font-mono">
              Asia/Kolkata window
            </div>
          </div>

          <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-600">
              Active Reservations
            </div>
            <div className="text-base font-bold text-amber-700 mt-1">
              {formatPaise(usage.activeReservationsPaise)}
            </div>
            <div className="text-[10px] text-slate-400 font-mono">
              Locked budget
            </div>
          </div>

          <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-blue-600">
              Remaining Budget
            </div>
            <div className="text-base font-bold text-blue-700 mt-1">
              {formatPaise(usage.remainingDailyBudgetPaise)}
            </div>
            <div className="text-[10px] text-slate-400 font-mono">
              Available to reserve
            </div>
          </div>
        </div>
      )}

      {/* Explanation Banner */}
      <div className="p-4 rounded-xl bg-blue-50/80 border border-blue-200 text-blue-950 text-xs space-y-1">
        <div className="font-bold flex items-center space-x-1.5 text-blue-900">
          <Info className="w-4 h-4 text-blue-600" />
          <span>Financial Protection Rules</span>
        </div>
        <p className="text-slate-700 leading-relaxed">
          &bull; <strong>Committed Reservations:</strong> Existing orders retain their reservations regardless of calendar day changes or policy edits.<br />
          &bull; <strong>Reduction Protection:</strong> The daily budget cannot be reduced below current committed spending ({usage ? formatPaise(usage.totalCommittedPaise) : '...'} paise).<br />
          &bull; <strong>Invalidation Guarantee:</strong> Saving a new policy version increments the version number, requiring unexecuted proposals and approvals to be re-evaluated.
        </p>
      </div>

      {/* Editable Form */}
      <form onSubmit={handleSave} className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Max Transaction Limit (₹)
            </label>
            <input
              type="number"
              min={1}
              required
              value={maxTxRupees}
              onChange={(e) => setMaxTxRupees(parseFloat(e.target.value) || 0)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:ring-2 focus:ring-blue-500"
            />
            <div className="text-[10px] text-slate-500 mt-0.5">
              = {Math.round(maxTxRupees * 100).toLocaleString('en-IN')} paise
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Daily Spend Budget (₹)
            </label>
            <input
              type="number"
              min={1}
              required
              value={dailyBudgetRupees}
              onChange={(e) => setDailyBudgetRupees(parseFloat(e.target.value) || 0)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:ring-2 focus:ring-blue-500"
            />
            <div className="text-[10px] text-slate-500 mt-0.5">
              = {Math.round(dailyBudgetRupees * 100).toLocaleString('en-IN')} paise
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Approval Threshold (₹)
            </label>
            <input
              type="number"
              min={0}
              required
              value={approvalThresholdRupees}
              onChange={(e) => setApprovalThresholdRupees(parseFloat(e.target.value) || 0)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:ring-2 focus:ring-blue-500"
            />
            <div className="text-[10px] text-slate-500 mt-0.5">
              Above this requires human approval
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Allowed Categories (comma separated)
            </label>
            <input
              type="text"
              required
              value={allowedCategoriesText}
              onChange={(e) => setAllowedCategoriesText(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
              placeholder="electronics, books"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Approved Merchant ID
            </label>
            <input
              type="text"
              required
              value={approvedMerchant}
              onChange={(e) => setApprovedMerchant(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:ring-2 focus:ring-blue-500"
              placeholder="demo_store"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center pt-2">
          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Policy Expiry Date & Time
            </label>
            <input
              type="datetime-local"
              required
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="pt-5">
            <label className="inline-flex items-center space-x-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allowSubscriptions}
                onChange={(e) => setAllowSubscriptions(e.target.checked)}
                className="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500"
              />
              <span className="text-xs font-semibold text-slate-700">
                Allow Subscription Products
              </span>
            </label>
            <div className="text-[11px] text-slate-500 ml-6 mt-0.5">
              Default is strictly unchecked (prohibited) for Phase 1.
            </div>
          </div>
        </div>

        <div className="pt-4 border-t flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="py-2.5 px-6 rounded-md font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 transition text-sm shadow-sm"
          >
            {saving ? 'Updating Policy...' : 'Save & Publish New Policy Version'}
          </button>
        </div>
      </form>
    </div>
  );
}
