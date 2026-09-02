'use client';

import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Shield,
  CreditCard,
  RefreshCw,
  ShoppingBag,
  Info,
  Layers,
  Sparkles,
  Bot,
} from 'lucide-react';
import { Product } from '@/domain/catalog';
import { PolicyEvaluation } from '@/domain/policy';
import { PurchaseIntent } from '@/domain/intent';
import { formatPaise } from '@/domain/money';

export default function ShopPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProductId, setSelectedProductId] = useState<string>('prod_keyboard');
  const [quantity, setQuantity] = useState<number>(1);
  const [purchaseBudgetRupees, setPurchaseBudgetRupees] = useState<number>(3000);
  const [reason, setReason] = useState<string>('Developer workspace upgrade');
  const [faultInjection, setFaultInjection] = useState<string>('NONE');

  // Phase 2 Agent & Payment states
  const [shoppingRequest, setShoppingRequest] = useState<string>(
    'I need a high-performance mechanical keyboard for coding'
  );
  const [paymentAdapterMode, setPaymentAdapterMode] = useState<'MOCK' | 'RAZORPAY_TEST'>('MOCK');
  const [agentMode, setAgentMode] = useState<string>('fixture');

  const [loading, setLoading] = useState<boolean>(false);
  const [activeIntent, setActiveIntent] = useState<PurchaseIntent | null>(null);
  const [activeEvaluation, setActiveEvaluation] = useState<PolicyEvaluation | null>(null);
  const [executionResult, setExecutionResult] = useState<any>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  // Load catalog
  const fetchProducts = async () => {
    try {
      const res = await fetch('/api/catalog');
      if (res.ok) {
        const data = await res.json();
        setProducts(data.products || []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchProducts();
  }, []);

  const selectedProduct = products.find((p) => p.id === selectedProductId) || products[0];
  const unitPricePaise = selectedProduct?.unit_price_paise || 0;
  const totalAmountPaise = unitPricePaise * quantity;
  const purchaseBudgetPaise = Math.round(purchaseBudgetRupees * 100);

  // Helper to dynamically load Razorpay script
  const loadRazorpayScript = (): Promise<boolean> => {
    return new Promise((resolve) => {
      if ((window as any).Razorpay) {
        resolve(true);
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.async = true;
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
  };

  // Quick Fixture preset handler
  const handleApplyFixture = (
    productId: string,
    qty: number,
    budgetRupees: number,
    fixtureReason: string
  ) => {
    setSelectedProductId(productId);
    setQuantity(qty);
    setPurchaseBudgetRupees(budgetRupees);
    setReason(fixtureReason);
    setExecutionResult(null);
    setErrorMessage(null);
    setInfoMessage(null);
  };

  // Ask AI Shopping Agent (Phase 2)
  const handleAskShoppingAgent = async () => {
    setLoading(true);
    setErrorMessage(null);
    setInfoMessage(null);
    setExecutionResult(null);

    try {
      const res = await fetch('/api/agent/propose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopping_request: shoppingRequest,
          purchase_budget_paise: purchaseBudgetPaise,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || data.message || 'AI Shopping Agent failed');
      }

      if (!data.suitable) {
        setErrorMessage(
          `AI Agent: No suitable catalog item found within budget. Rationale: ${data.reason}`
        );
        setActiveIntent(null);
        setActiveEvaluation(null);
        return;
      }

      setActiveIntent(data.intent);
      setActiveEvaluation(data.evaluation);
      if (data.intent?.product_id) {
        setSelectedProductId(data.intent.product_id);
        setQuantity(data.intent.quantity || 1);
      }
      setInfoMessage(
        `AI Shopping Agent proposed: ${data.intent.product_id} (${data.source_mode || 'MODEL'}) - ${data.reason}`
      );
    } catch (err: any) {
      setErrorMessage(err.message || 'Error communicating with AI Shopping Agent');
    } finally {
      setLoading(false);
    }
  };

  // Manual Propose purchase
  const handleProposePurchase = async () => {
    setLoading(true);
    setErrorMessage(null);
    setInfoMessage(null);
    setExecutionResult(null);

    const idempotencyKey = `user-prop-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    try {
      const res = await fetch('/api/intents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_id: selectedProductId,
          quantity,
          purchase_budget_paise: purchaseBudgetPaise,
          idempotency_key: idempotencyKey,
          source_mode: 'MANUAL',
          reason,
          fault_injection: faultInjection,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to submit proposal');
      }

      setActiveIntent(data.intent);
      setActiveEvaluation(data.evaluation);
    } catch (err: any) {
      setErrorMessage(err.message || 'Error proposing purchase');
    } finally {
      setLoading(false);
    }
  };

  // Human operator approval
  const handleApprove = async () => {
    if (!activeIntent) return;
    setLoading(true);
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/intents/${activeIntent.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'Operator manual authorization' }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Approval failed');
      }
      setActiveIntent(data.intent);
    } catch (err: any) {
      setErrorMessage(err.message || 'Error approving purchase');
    } finally {
      setLoading(false);
    }
  };

  // Human operator decline
  const handleDecline = async () => {
    if (!activeIntent) return;
    setLoading(true);
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/intents/${activeIntent.id}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Declined by operator review' }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Decline failed');
      }
      setActiveIntent(data.intent);
    } catch (err: any) {
      setErrorMessage(err.message || 'Error declining purchase');
    } finally {
      setLoading(false);
    }
  };

  // Open Razorpay Standard Checkout
  const launchRazorpayCheckout = async (orderId: string, keyId: string, intent: PurchaseIntent) => {
    const loaded = await loadRazorpayScript();
    if (!loaded) {
      setErrorMessage('Failed to load Razorpay Standard Checkout script. Check connection.');
      return;
    }

    const options = {
      key: keyId,
      amount: intent.total_amount_paise,
      currency: intent.currency,
      name: 'BoundPay Store',
      description: selectedProduct?.name || 'Order Checkout',
      order_id: orderId,
      notes: {
        intent_id: intent.id,
      },
      handler: async (response: {
        razorpay_payment_id: string;
        razorpay_order_id: string;
        razorpay_signature: string;
      }) => {
        setLoading(true);
        try {
          const confirmRes = await fetch(`/api/intents/${intent.id}/confirm-payment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(response),
          });
          const confirmData = await confirmRes.json();
          if (!confirmRes.ok) {
            throw new Error(confirmData.message || confirmData.error || 'Payment verification failed');
          }
          setExecutionResult(confirmData);
          if (confirmData.intent) setActiveIntent(confirmData.intent);
          setInfoMessage('Razorpay payment verified and confirmed on server!');
        } catch (e: any) {
          setErrorMessage(e.message || 'Payment confirmation failed');
        } finally {
          setLoading(false);
        }
      },
      modal: {
        ondismiss: () => {
          setInfoMessage(
            'Razorpay Checkout modal closed. Your atomic budget reservation is held safely. You can complete payment or refresh status.'
          );
        },
      },
      theme: {
        color: '#2563EB',
      },
    };

    const rzp = new (window as any).Razorpay(options);
    rzp.open();
  };

  // Checkout execution
  const handleExecuteCheckout = async () => {
    if (!activeIntent) return;
    setLoading(true);
    setErrorMessage(null);
    setInfoMessage(null);

    try {
      const res = await fetch(`/api/intents/${activeIntent.id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fault_injection: faultInjection }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Checkout execution failed');
      }

      setExecutionResult(data.result);
      if (data.result.intent) {
        setActiveIntent(data.result.intent);
      }

      // If Razorpay Test Mode and order created, launch modal
      if (
        data.result.status === 'ORDER_CREATED' &&
        data.result.providerOrderId &&
        data.result.keyId
      ) {
        await launchRazorpayCheckout(
          data.result.providerOrderId,
          data.result.keyId,
          data.result.intent
        );
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Execution error');
    } finally {
      setLoading(false);
    }
  };

  // Refresh Provider Status
  const handleRefreshStatus = async () => {
    if (!activeIntent) return;
    setLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/intents/${activeIntent.id}/refresh-status`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Status refresh failed');
      setExecutionResult(data);
      if (data.intent) setActiveIntent(data.intent);
      setInfoMessage(`Provider status: ${data.status} - ${data.message}`);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to refresh provider status');
    } finally {
      setLoading(false);
    }
  };

  // Reconcile Uncertain Intent
  const handleReconcile = async () => {
    if (!activeIntent) return;
    setLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/intents/${activeIntent.id}/reconcile`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Reconciliation failed');
      setExecutionResult(data);
      if (data.intent) setActiveIntent(data.intent);
      setInfoMessage(`Reconciliation: ${data.message}`);
    } catch (err: any) {
      setErrorMessage(err.message || 'Reconciliation check failed');
    } finally {
      setLoading(false);
    }
  };

  const getStateBadge = (state: string) => {
    switch (state) {
      case 'READY':
        return <span className="bg-emerald-100 text-emerald-800 border border-emerald-300 font-semibold px-2.5 py-0.5 rounded text-xs">READY FOR CHECKOUT</span>;
      case 'NEEDS_APPROVAL':
        return <span className="bg-amber-100 text-amber-900 border border-amber-300 font-semibold px-2.5 py-0.5 rounded text-xs">NEEDS HUMAN APPROVAL</span>;
      case 'APPROVED':
        return <span className="bg-blue-100 text-blue-800 border border-blue-300 font-semibold px-2.5 py-0.5 rounded text-xs">OPERATOR APPROVED</span>;
      case 'DECLINED':
        return <span className="bg-rose-100 text-rose-800 border border-rose-300 font-semibold px-2.5 py-0.5 rounded text-xs">OPERATOR DECLINED</span>;
      case 'BLOCKED':
        return <span className="bg-red-100 text-red-800 border border-red-300 font-semibold px-2.5 py-0.5 rounded text-xs">POLICY BLOCKED</span>;
      case 'EXECUTING':
        return <span className="bg-indigo-100 text-indigo-800 border border-indigo-300 font-semibold px-2.5 py-0.5 rounded text-xs">EXECUTING RESERVATION</span>;
      case 'ORDER_CREATED':
        return <span className="bg-cyan-100 text-cyan-800 border border-cyan-300 font-semibold px-2.5 py-0.5 rounded text-xs">ORDER CREATED (AWAITING CHECKOUT)</span>;
      case 'PAYMENT_CONFIRMED':
        return <span className="bg-emerald-600 text-white font-bold px-2.5 py-0.5 rounded text-xs">PAYMENT CONFIRMED</span>;
      case 'UNKNOWN':
        return <span className="bg-purple-100 text-purple-800 border border-purple-300 font-semibold px-2.5 py-0.5 rounded text-xs">PROVIDER UNCERTAIN</span>;
      case 'EXPIRED':
        return <span className="bg-slate-200 text-slate-700 border border-slate-300 font-semibold px-2.5 py-0.5 rounded text-xs">EXPIRED</span>;
      default:
        return <span className="bg-slate-100 text-slate-800 border border-slate-300 font-semibold px-2.5 py-0.5 rounded text-xs">{state}</span>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner with Phase Badges */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center space-x-2">
            <ShoppingBag className="w-5 h-5 text-blue-600" />
            <span>Agentic Commerce Shop & Bounded Authority</span>
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Phase 1 & 2: Natural-language agent proposals, deterministic spending policy gates, exact-intent approvals, and Razorpay TEST standard checkout.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="bg-amber-100 text-amber-900 text-xs font-semibold px-3 py-1 rounded-full border border-amber-300 flex items-center space-x-1">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
            <span>MOCK PAYMENT ADAPTER</span>
          </span>
          <span className="bg-blue-100 text-blue-900 text-xs font-semibold px-3 py-1 rounded-full border border-blue-300 flex items-center space-x-1">
            <Shield className="w-3.5 h-3.5 text-blue-600" />
            <span>DETERMINISTIC BOUNDED AUTHORITY</span>
          </span>
          <span className="bg-indigo-100 text-indigo-900 text-xs font-semibold px-3 py-1 rounded-full border border-indigo-300 flex items-center space-x-1">
            <Bot className="w-3.5 h-3.5 text-indigo-600" />
            <span>OPENAI AGENT PROPOSALS</span>
          </span>
        </div>
      </div>

      {infoMessage && (
        <div className="p-3.5 rounded-lg bg-blue-50 border border-blue-200 text-blue-900 text-xs flex items-center space-x-2">
          <Info className="w-4 h-4 flex-shrink-0 text-blue-600" />
          <div>{infoMessage}</div>
        </div>
      )}

      {errorMessage && (
        <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm flex items-start space-x-2">
          <XCircle className="w-5 h-5 flex-shrink-0 text-red-500 mt-0.5" />
          <div>
            <div className="font-semibold">Action Encountered Error</div>
            <div>{errorMessage}</div>
          </div>
        </div>
      )}

      {/* Grid: Left Column (Catalog & Presets), Right Column (AI Agent & Authority) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Product Catalog & Presets */}
        <div className="lg:col-span-6 space-y-6">
          {/* Catalog Section */}
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-bold text-slate-800 flex items-center space-x-2">
                <Layers className="w-4 h-4 text-blue-600" />
                <span>Server-Controlled Catalog</span>
              </h2>
              <span className="text-xs text-slate-400">All prices include tax & shipping</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {products.map((prod) => {
                const isSelected = selectedProductId === prod.id;
                return (
                  <div
                    key={prod.id}
                    onClick={() => {
                      setSelectedProductId(prod.id);
                      setExecutionResult(null);
                    }}
                    className={`cursor-pointer p-3.5 rounded-lg border text-left transition-all ${
                      isSelected
                        ? 'border-blue-500 bg-blue-50/50 ring-2 ring-blue-500/20'
                        : 'border-slate-200 hover:border-slate-300 bg-slate-50/40'
                    }`}
                  >
                    <div className="flex justify-between items-start">
                      <div className="font-semibold text-slate-900 text-sm">{prod.name}</div>
                      <span className="text-xs font-mono font-bold text-blue-700 ml-2">
                        {formatPaise(prod.unit_price_paise)}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-1 line-clamp-2">{prod.description}</p>
                    <div className="mt-2.5 flex items-center justify-between text-[11px]">
                      <span className="bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded font-mono">
                        {prod.category}
                      </span>
                      {prod.is_subscription ? (
                        <span className="bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-semibold">
                          Subscription
                        </span>
                      ) : (
                        <span className="text-slate-400 font-mono">{prod.unit_price_paise} paise</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Test Fixture Scenarios */}
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
            <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wider mb-3">
              Phase 1 Test Fixture Scenarios
            </h2>
            <div className="space-y-2">
              <button
                type="button"
                onClick={() =>
                  handleApplyFixture(
                    'prod_keyboard',
                    1,
                    3000,
                    'Engineering keyboard upgrade (exceeds ₹2,500 approval threshold)'
                  )
                }
                className="w-full text-left p-2.5 rounded-lg border border-amber-200 bg-amber-50/40 hover:bg-amber-100/60 transition text-xs flex justify-between items-center"
              >
                <div>
                  <span className="font-semibold text-amber-900">1. Mechanical Keyboard x1</span>
                  <div className="text-slate-600 mt-0.5">₹2,799 &bull; Requires Human Approval (&gt; ₹2,500 threshold)</div>
                </div>
                <span className="bg-amber-200/80 text-amber-900 font-bold px-2 py-1 rounded text-[10px]">
                  NEEDS APPROVAL
                </span>
              </button>

              <button
                type="button"
                onClick={() =>
                  handleApplyFixture(
                    'prod_mouse',
                    1,
                    2000,
                    'Standard wireless mouse replacement'
                  )
                }
                className="w-full text-left p-2.5 rounded-lg border border-emerald-200 bg-emerald-50/40 hover:bg-emerald-100/60 transition text-xs flex justify-between items-center"
              >
                <div>
                  <span className="font-semibold text-emerald-900">2. Wireless Mouse x1</span>
                  <div className="text-slate-600 mt-0.5">₹1,499 &bull; Auto-Allowed (&le; ₹2,500 threshold)</div>
                </div>
                <span className="bg-emerald-200/80 text-emerald-900 font-bold px-2 py-1 rounded text-[10px]">
                  AUTO-READY
                </span>
              </button>

              <button
                type="button"
                onClick={() =>
                  handleApplyFixture(
                    'prod_book',
                    1,
                    1000,
                    'Data systems architecture study guide'
                  )
                }
                className="w-full text-left p-2.5 rounded-lg border border-emerald-200 bg-emerald-50/40 hover:bg-emerald-100/60 transition text-xs flex justify-between items-center"
              >
                <div>
                  <span className="font-semibold text-emerald-900">3. Systems Engineering Book x1</span>
                  <div className="text-slate-600 mt-0.5">₹899 &bull; Auto-Allowed books category</div>
                </div>
                <span className="bg-emerald-200/80 text-emerald-900 font-bold px-2 py-1 rounded text-[10px]">
                  AUTO-READY
                </span>
              </button>

              <button
                type="button"
                onClick={() =>
                  handleApplyFixture(
                    'prod_subscription',
                    1,
                    15000,
                    'Support plan subscription inquiry'
                  )
                }
                className="w-full text-left p-2.5 rounded-lg border border-red-200 bg-red-50/40 hover:bg-red-100/60 transition text-xs flex justify-between items-center"
              >
                <div>
                  <span className="font-semibold text-red-900">4. Support Plan Subscription</span>
                  <div className="text-slate-600 mt-0.5">₹12,999 &bull; Subscriptions prohibited by default policy</div>
                </div>
                <span className="bg-red-200/80 text-red-900 font-bold px-2 py-1 rounded text-[10px]">
                  BLOCKED
                </span>
              </button>

              <button
                type="button"
                onClick={() =>
                  handleApplyFixture(
                    'prod_keyboard',
                    2,
                    6000,
                    'Two mechanical keyboards (exceeds ₹4,000 transaction limit)'
                  )
                }
                className="w-full text-left p-2.5 rounded-lg border border-red-200 bg-red-50/40 hover:bg-red-100/60 transition text-xs flex justify-between items-center"
              >
                <div>
                  <span className="font-semibold text-red-900">5. Mechanical Keyboards x2</span>
                  <div className="text-slate-600 mt-0.5">₹5,598 &bull; Exceeds policy max transaction ₹4,000</div>
                </div>
                <span className="bg-red-200/80 text-red-900 font-bold px-2 py-1 rounded text-[10px]">
                  BLOCKED
                </span>
              </button>
            </div>
          </div>
        </div>

        {/* Right: AI Shopping Agent & Proposal Control */}
        <div className="lg:col-span-6 space-y-6">
          {/* Phase 2: AI Shopping Agent Card */}
          <div className="bg-gradient-to-br from-indigo-900 to-slate-900 text-white p-5 rounded-xl border border-indigo-700 shadow-md">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center space-x-2">
                <Sparkles className="w-5 h-5 text-indigo-400" />
                <h2 className="text-sm font-bold tracking-wider uppercase">AI Shopping Agent</h2>
              </div>
              <span className="text-[11px] bg-indigo-800 text-indigo-200 px-2 py-0.5 rounded font-mono">
                {process.env.NEXT_PUBLIC_AGENT_MODE === 'live' ? 'LIVE (OpenAI)' : 'FIXTURE / MOCK'}
              </span>
            </div>

            <p className="text-xs text-slate-300 mb-3">
              Enter what you want to buy. The agent reasons over untrusted descriptions and proposes a catalog product. Deterministic policy gates strictly enforce limits.
            </p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-indigo-200 mb-1">
                  Natural Language Shopping Request
                </label>
                <input
                  type="text"
                  value={shoppingRequest}
                  onChange={(e) => setShoppingRequest(e.target.value)}
                  placeholder="e.g. Ergonomic wireless mouse for travel under ₹2,000"
                  className="w-full p-2.5 rounded bg-slate-800 border border-indigo-700 text-white text-xs placeholder-slate-400 focus:ring-2 focus:ring-indigo-400"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="flex-1">
                  <label className="block text-[11px] text-indigo-300">Purchase Budget (₹)</label>
                  <input
                    type="number"
                    min={1}
                    value={purchaseBudgetRupees}
                    onChange={(e) => setPurchaseBudgetRupees(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-full p-1.5 rounded bg-slate-800 border border-indigo-700 text-white text-xs"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleAskShoppingAgent}
                  disabled={loading}
                  className="mt-4 px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-bold transition flex items-center space-x-1.5 shadow"
                >
                  <Bot className="w-4 h-4" />
                  <span>Ask AI Shopping Agent to Propose</span>
                </button>
              </div>
            </div>
          </div>

          {/* Proposal Config Card */}
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
            <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wider mb-4 flex items-center space-x-1.5">
              <CreditCard className="w-4 h-4 text-blue-600" />
              <span>Purchase Proposal Control</span>
            </h2>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Selected Product
                  </label>
                  <div className="p-2 border border-slate-300 rounded bg-slate-50 text-xs font-medium text-slate-800 truncate">
                    {selectedProduct?.name || 'Select Product'}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Quantity (1 - 10)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={quantity}
                    onChange={(e) => setQuantity(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                    className="w-full p-2 border border-slate-300 rounded text-xs font-medium focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Explicit Purchase Budget (₹)
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={purchaseBudgetRupees}
                    onChange={(e) => setPurchaseBudgetRupees(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-full p-2 border border-slate-300 rounded text-xs font-medium focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="text-[11px] text-slate-400 font-mono mt-0.5 block">
                    = {purchaseBudgetPaise.toLocaleString('en-IN')} paise
                  </span>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Mock Fault Injection
                  </label>
                  <select
                    value={faultInjection}
                    onChange={(e) => setFaultInjection(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded text-xs font-medium focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="NONE">None (Happy Path)</option>
                    <option value="SIMULATE_REJECTION">Simulate Bank Rejection</option>
                    <option value="SIMULATE_TIMEOUT">Simulate Gateway Timeout</option>
                    <option value="SIMULATE_RESPONSE_LOSS">Simulate Response Loss</option>
                    <option value="SIMULATE_PENDING">Simulate Pending Auth</option>
                    <option value="SIMULATE_DUPLICATE">Simulate Duplicate Capture</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Agent Shopping Reason (Untrusted Text)
                </label>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="AI prompt or rationale..."
                  className="w-full p-2 border border-slate-300 rounded text-xs focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* Live Cost Calculation Display */}
              <div className="p-3 bg-slate-900 rounded-lg text-white flex items-center justify-between">
                <div>
                  <div className="text-xs text-slate-400">Server-Computed Total:</div>
                  <div className="text-xs text-slate-300 font-mono">
                    {unitPricePaise} &times; {quantity} = <span className="font-bold text-amber-400">{totalAmountPaise} paise</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-bold text-white">{formatPaise(totalAmountPaise)}</div>
                  <div className="text-[10px] text-emerald-400">Zero floating point math</div>
                </div>
              </div>

              <button
                type="button"
                onClick={handleProposePurchase}
                disabled={loading}
                className="w-full py-2.5 px-4 rounded-md font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 transition text-xs shadow-sm"
              >
                {loading ? 'Evaluating Policy...' : 'Submit Proposal to Policy Engine'}
              </button>
            </div>
          </div>

          {/* Active Proposal & Policy Evaluation Breakdown */}
          {activeIntent && activeEvaluation && (
            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
              <div className="flex items-center justify-between border-b pb-3">
                <div>
                  <div className="flex items-center space-x-2">
                    <span className="text-xs text-slate-400">Intent ID:</span>
                    <span className="font-mono text-xs font-bold text-slate-800 truncate max-w-xs">
                      {activeIntent.id}
                    </span>
                  </div>
                  {activeIntent.source_mode && (
                    <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded mt-0.5 inline-block font-mono">
                      Source: {activeIntent.source_mode} {activeIntent.model_name ? `(${activeIntent.model_name})` : ''}
                    </span>
                  )}
                </div>
                <div>{getStateBadge(activeIntent.state)}</div>
              </div>

              {/* Individual Policy Checks List */}
              <div>
                <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">
                  Deterministic Policy Checks
                </h3>
                <div className="space-y-1.5">
                  {activeEvaluation.checks.map((c, i) => (
                    <div
                      key={i}
                      className={`p-2 rounded border text-xs flex items-start space-x-2 ${
                        c.passed
                          ? 'bg-emerald-50/60 border-emerald-200 text-emerald-900'
                          : c.rule === 'APPROVAL_THRESHOLD'
                          ? 'bg-amber-50/80 border-amber-200 text-amber-900'
                          : 'bg-red-50/70 border-red-200 text-red-900'
                      }`}
                    >
                      {c.passed ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                      ) : c.rule === 'APPROVAL_THRESHOLD' ? (
                        <Clock className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                      ) : (
                        <XCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1">
                        <div className="font-semibold text-[11px] uppercase tracking-wide">
                          {c.rule}
                        </div>
                        <div className="text-[11px] mt-0.5">{c.message}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Action Buttons based on state */}
              <div className="pt-2 border-t flex flex-wrap gap-2">
                {activeIntent.state === 'NEEDS_APPROVAL' && (
                  <>
                    <button
                      type="button"
                      onClick={handleApprove}
                      disabled={loading}
                      className="flex-1 py-2 px-3 rounded bg-amber-600 hover:bg-amber-500 text-white font-medium text-xs transition"
                    >
                      Human Operator Approve
                    </button>
                    <button
                      type="button"
                      onClick={handleDecline}
                      disabled={loading}
                      className="py-2 px-3 rounded bg-slate-200 hover:bg-rose-100 hover:text-rose-700 text-slate-700 font-medium text-xs transition"
                    >
                      Decline
                    </button>
                  </>
                )}

                {(activeIntent.state === 'READY' || activeIntent.state === 'APPROVED') && (
                  <button
                    type="button"
                    onClick={handleExecuteCheckout}
                    disabled={loading}
                    className="w-full py-2.5 px-4 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs transition shadow flex items-center justify-center space-x-1.5"
                  >
                    <CreditCard className="w-4 h-4" />
                    <span>Execute Atomic Reservation & Mock Checkout</span>
                  </button>
                )}

                {activeIntent.state === 'ORDER_CREATED' && (
                  <div className="w-full space-y-2">
                    <div className="p-3 rounded-lg bg-cyan-50 border border-cyan-200 text-cyan-950 text-xs">
                      <div className="font-bold flex items-center space-x-1">
                        <Clock className="w-4 h-4 text-cyan-600" />
                        <span>Order Created on Provider</span>
                      </div>
                      <div className="mt-1 font-mono text-[11px]">
                        Order ID: {activeIntent.provider_order_id || executionResult?.providerOrderId || 'N/A'}<br />
                        Receipt: {activeIntent.receipt || 'N/A'}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleRefreshStatus}
                        disabled={loading}
                        className="flex-1 py-2 px-3 rounded bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs transition flex items-center justify-center space-x-1"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Refresh Provider Status</span>
                      </button>
                    </div>
                  </div>
                )}

                {activeIntent.state === 'PAYMENT_CONFIRMED' && (
                  <div className="w-full p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs">
                    <div className="font-bold flex items-center space-x-1">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      <span>Payment Verified & Confirmed [MOCK_PAYMENT]</span>
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-emerald-800">
                      Provider Order: {activeIntent.provider_order_id || executionResult?.providerOrderId || 'N/A'}<br />
                      Provider Payment: {activeIntent.provider_payment_id || executionResult?.providerPaymentId || 'N/A'}
                    </div>
                  </div>
                )}

                {activeIntent.state === 'UNKNOWN' && (
                  <div className="w-full p-3 rounded-lg bg-purple-50 border border-purple-200 text-purple-900 text-xs space-y-2">
                    <div className="font-bold flex items-center space-x-1">
                      <AlertTriangle className="w-4 h-4 text-purple-600" />
                      <span>Provider Response Indeterminate</span>
                    </div>
                    <div className="text-[11px] text-purple-800">
                      {activeIntent.failure_reason || 'Gateway timeout or lost response. Budget reservation remains durably held.'}
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        onClick={handleRefreshStatus}
                        disabled={loading}
                        className="py-1.5 px-3 rounded bg-purple-700 hover:bg-purple-600 text-white font-medium text-xs"
                      >
                        Refresh Status
                      </button>
                      <button
                        type="button"
                        onClick={handleReconcile}
                        disabled={loading}
                        className="py-1.5 px-3 rounded bg-slate-200 hover:bg-slate-300 text-slate-800 font-medium text-xs"
                      >
                        Reconcile by Receipt
                      </button>
                    </div>
                  </div>
                )}

                {activeIntent.state === 'BLOCKED' && (
                  <div className="w-full p-3 rounded-lg bg-red-50 border border-red-200 text-red-900 text-xs">
                    <div className="font-bold flex items-center space-x-1">
                      <XCircle className="w-4 h-4 text-red-600" />
                      <span>Purchase Proposal Blocked</span>
                    </div>
                    <div className="mt-1 text-[11px] text-red-800">
                      {activeIntent.failure_reason || 'Policy constraints violated.'}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
