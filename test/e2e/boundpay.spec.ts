import { test, expect } from '@playwright/test';

test('Unauthenticated protected view redirects to operator login', async ({ page }) => {
  await page.goto('/activity');
  await page.waitForURL('/login');
  await expect(page.getByRole('heading', { name: /Operator Authentication/i })).toBeVisible();
});

test.describe('BoundPay Operator E2E Browser Scenarios', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to /login
    await page.goto('/login');
    // Login with operator credentials
    await page.fill('input[placeholder="e.g. operator"]', 'operator');
    await page.fill('input[placeholder="••••••••••••"]', 'BoundPayPass123!');
    await page.click('button:has-text("Sign In as Operator")');
    await page.waitForURL('/shop');
  });

  test('Scenario 1: Operator login and Wireless Mouse auto-allowed', async ({ page }) => {
    // Verify on Shop page with badges
    await expect(page.locator('text=Agentic Commerce Shop & Bounded Authority')).toBeVisible();
    await expect(page.getByText('MOCK PAYMENT — NOT RAZORPAY', { exact: true })).toBeVisible();

    // Click quick fixture: 2. Wireless Mouse x1
    await page.click('button:has-text("2. Wireless Mouse x1")');

    // Submit proposal
    await page.click('button:has-text("Submit Proposal to Policy Engine")');

    // Verify state badge is READY FOR CHECKOUT
    await expect(page.locator('text=READY FOR CHECKOUT')).toBeVisible();

    // Execute checkout
    await page.getByRole('button', { name: 'Execute with labeled mock provider' }).click();

    // Verify payment confirmed badge
    await expect(page.getByText('Payment confirmed [MOCK — SYNTHETIC]')).toBeVisible();
  });

  test('Scenario 2: Mechanical Keyboard requires human approval and executes after approval', async ({ page }) => {
    // Click quick fixture: 1. Mechanical Keyboard x1
    await page.click('button:has-text("1. Mechanical Keyboard x1")');

    // Submit proposal
    await page.click('button:has-text("Submit Proposal to Policy Engine")');

    // Verify state is NEEDS HUMAN APPROVAL
    await expect(page.locator('text=NEEDS HUMAN APPROVAL')).toBeVisible();
    await expect(page.locator('button:has-text("Human Operator Approve")')).toBeVisible();

    // Human operator clicks approve
    await page.click('button:has-text("Human Operator Approve")');

    // Verify state transitioned to OPERATOR APPROVED and checkout is now available
    await expect(page.locator('text=OPERATOR APPROVED')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Execute with labeled mock provider' })).toBeVisible();

    // Complete checkout
    await page.getByRole('button', { name: 'Execute with labeled mock provider' }).click();
    await expect(page.getByText('Payment confirmed [MOCK — SYNTHETIC]')).toBeVisible();
  });

  test('Scenario 3: Subscription product is BLOCKED by deterministic policy', async ({ page }) => {
    // Click quick fixture: 4. Support Plan Subscription
    await page.click('button:has-text("4. Support Plan Subscription")');

    // Submit proposal
    await page.click('button:has-text("Submit Proposal to Policy Engine")');

    // Verify state is POLICY BLOCKED
    await expect(page.locator('text=POLICY BLOCKED')).toBeVisible();
    await expect(page.locator('text=Subscriptions are strictly prohibited by standing policy').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Execute with labeled mock provider' })).not.toBeVisible();
  });

  test('Scenario 4: Policy view displays live budget usage and updates policy', async ({ page }) => {
    await page.goto('/policy');
    await expect(page.locator('text=Spending Policy Authority')).toBeVisible();
    await expect(page.getByText('Daily Budget', { exact: true })).toBeVisible();
    await expect(page.getByText('Active Reservations', { exact: true })).toBeVisible();

    // Verify financial protection notice
    await expect(page.locator('text=Financial Protection Rules')).toBeVisible();

    // Operator updates daily budget to ₹10,000 (1000000 paise)
    await page.fill('input[value="5000"]', '10000');
    await page.click('button:has-text("Save & Publish New Policy Version")');
    await expect(page.locator('text=Policy successfully updated to Version 2')).toBeVisible();
  });

  test('Scenario 5: Activity view displays persistent audit events and export', async ({ page }) => {
    await page.goto('/activity');
    await expect(page.locator('text=Audit Trail & Activity Log')).toBeVisible();
    await expect(page.locator('a:has-text("Export Audit JSON")')).toBeVisible();
  });

  test('Scenario 6: Repeated clicks on checkout do not duplicate the order', async ({ page }) => {
    await page.goto('/shop');
    await page.click('button:has-text("3. Systems Engineering Book x1")');
    await page.click('button:has-text("Submit Proposal to Policy Engine")');
    await expect(page.locator('text=READY FOR CHECKOUT')).toBeVisible();

    const checkoutBtn = page.getByRole('button', { name: 'Execute with labeled mock provider' });
    await checkoutBtn.click();
    await expect(page.getByText('Payment confirmed [MOCK — SYNTHETIC]')).toBeVisible();

    const providerOrder = await page.getByText(/Provider Order:/).textContent();
    await page.getByRole('button', { name: 'Replay identical checkout request (idempotency proof)' }).click();
    await expect(page.getByText('Payment confirmed [MOCK — SYNTHETIC]')).toBeVisible();
    await expect(page.getByText(providerOrder!)).toBeVisible();
  });

  test('Scenario 7: Error messages are visible and actionable when policy fails', async ({ page }) => {
    await page.click('button:has-text("5. Mechanical Keyboards x2")');
    await page.click('button:has-text("Submit Proposal to Policy Engine")');

    // Verify failure explanation is visible
    await expect(page.locator('text=POLICY BLOCKED')).toBeVisible();
    await expect(page.locator('text=Purchase Proposal Blocked')).toBeVisible();
    await expect(page.locator('text=MAX_TRANSACTION_LIMIT').first()).toBeVisible();
  });

  test('Scenario 8: Page reload preserves operator authentication session', async ({ page }) => {
    await page.reload();
    await expect(page.getByText('Operator', { exact: true })).toBeVisible();
    await expect(page.locator('text=operator').first()).toBeVisible();
    await expect(page.locator('button:has-text("Logout")')).toBeVisible();
  });

  test('Scenario 9: AI Shopping Agent proposes product from natural language request', async ({ page }) => {
    // Fill shopping request input
    await page.fill('input[placeholder="e.g. Ergonomic wireless mouse for travel under ₹2,000"]', 'I need a wireless mouse for travel');
    await page.click('button:has-text("Ask AI Shopping Agent to Propose")');

    // Verify proposal returned by agent and evaluated by policy
    await expect(page.locator('text=READY FOR CHECKOUT')).toBeVisible();
    await expect(page.locator('text=Wireless Mouse').first()).toBeVisible();
    await expect(page.locator('text=Source: FIXTURE')).toBeVisible();
  });

  test('Scenario 10: AI Shopping Agent returns rejection when no items match request', async ({ page }) => {
    await page.fill('input[placeholder="e.g. Ergonomic wireless mouse for travel under ₹2,000"]', 'unobtainium alien artifact spaceship');
    await page.click('button:has-text("Ask AI Shopping Agent to Propose")');

    await expect(page.locator('text=No catalog item matched your shopping request in fixture mode.')).toBeVisible();
  });

  test('Scenario 11: changed server price durably invalidates exact approval before provider dispatch', async ({ page }) => {
    await page.getByRole('button', { name: /1\. Legitimate purchase/ }).click();
    await page.getByRole('button', { name: 'Submit Proposal to Policy Engine' }).click();
    await page.getByRole('button', { name: 'Human Operator Approve' }).click();
    await page.getByRole('button', { name: /3\. Change price to 429900/ }).click();
    await page.getByRole('button', { name: 'Execute with labeled mock provider' }).click();
    await expect(page.getByText('Authorization expired or invalidated')).toBeVisible();
    await expect(page.getByText(/new proposal and authorization required/i)).toBeVisible();

    await page.request.put('/api/catalog/prod_keyboard', { data: { unit_price_paise: 279900 } });
  });

  test('Scenario 12: mock response loss is UNKNOWN, retains authority, and offers reconciliation without retry', async ({ page }) => {
    await page.getByRole('button', { name: /4\. Response-loss fault/ }).click();
    await page.getByRole('button', { name: 'Submit Proposal to Policy Engine' }).click();
    await page.getByRole('button', { name: 'Execute with labeled mock provider' }).click();
    await expect(page.getByText('PROVIDER UNCERTAIN')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reconcile by Receipt' })).toBeVisible();
    await page.getByRole('button', { name: 'Reconcile by Receipt' }).click();
    await expect(page.getByText(/no matching captured order found/i)).toBeVisible();
  });

  test('Scenario 13: narrow mobile viewport keeps core amount, budget and action usable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/shop');
    await expect(page.getByRole('heading', { name: 'Purchase at a glance' })).toBeVisible();
    await expect(page.getByLabel('Explicit purchase budget in rupees')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Evaluate purchase' })).toBeVisible();
  });

  test('Scenario 14: logout revokes access and returns to login', async ({ page }) => {
    await page.getByRole('button', { name: 'Logout' }).click();
    await page.waitForURL('/login');
    await page.goto('/policy');
    await page.waitForURL('/login');
  });

  test('Scenario 15: create/select passport, inspect every debugger stage, verify receipt, and preserve it on reload', async ({ page }) => {
    const externalProviderRequests: string[] = [];
    page.on('request', (request) => {
      if (/sarvam|razorpay/i.test(request.url())) externalProviderRequests.push(request.url());
    });
    await page.goto('/passports');
    await page.getByRole('button', { name: 'Create passport' }).click();
    await page.getByLabel('Agent ID').fill('browserbot');
    await page.getByLabel('Agent display name').fill('Browser Bot');
    await page.getByLabel('Allowed merchant IDs').fill('demo_store');
    await page.getByLabel('Allowed categories').fill('electronics, books');
    await page.getByLabel('Max / transaction (₹)').fill('4000');
    await page.getByLabel('Cumulative budget (₹)').fill('10000');
    await page.getByLabel('Approval above (₹)').fill('3000');
    await page.getByLabel('Maximum usages').fill('4');
    await page.getByRole('button', { name: 'Issue signed passport' }).click();
    await expect(page.getByText(/Signed passport issued for Browser Bot/)).toBeVisible();
    await expect(page.getByText('browserbot', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Ed25519 / EdDSA payload')).toBeVisible();

    await page.goto('/shop');
    const browserPassportOption = page.locator('#authority-passport option').filter({ hasText: 'Browser Bot' }).first();
    await page.getByLabel('Authority Passport').selectOption((await browserPassportOption.getAttribute('value')) || '');
    await page.getByRole('button', { name: /2\. Wireless Mouse x1/ }).click();
    await page.getByRole('button', { name: 'Submit Proposal to Policy Engine' }).click();
    await expect(page.getByRole('heading', { name: 'Visual Authorization Debugger' })).toBeVisible();
    await expect(page.getByText('PASSPORT_SIGNATURE_VALID')).toBeVisible();
    await expect(page.getByText('PASSPORT_ACTIVE')).toBeVisible();
    await expect(page.getByText('PASSPORT_OWNER_MATCH')).toBeVisible();
    await expect(page.getByText('PASSPORT_AGENT_MATCH')).toBeVisible();
    await expect(page.getByText('MERCHANT_INTERSECTION_ALLOWED')).toBeVisible();
    await expect(page.getByText('CATEGORY_INTERSECTION_ALLOWED')).toBeVisible();
    await expect(page.getByText('SUBSCRIPTION_POLICY_ALLOWED')).toBeVisible();
    await expect(page.getByText('TRANSACTION_LIMIT_INTERSECTION_ALLOWED')).toBeVisible();
    await expect(page.getByText('PASSPORT_CUMULATIVE_BUDGET_AVAILABLE')).toBeVisible();
    await expect(page.getByText('PASSPORT_USAGE_AVAILABLE')).toBeVisible();
    await expect(page.getByText('SERVER_BUDGET_AVAILABLE')).toBeVisible();
    await expect(page.getByText('APPROVAL_NOT_REQUIRED')).toBeVisible();
    await expect(page.getByText('QUOTE_AND_POLICY_VERSIONS_CURRENT')).toBeVisible();
    await expect(page.getByText('EXECUTION_PERMITTED')).toBeVisible();
    await page.getByRole('button', { name: 'Verify receipt signature' }).click();
    await expect(page.getByText('SIGNATURE VERIFIED')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Persisted signed authorization receipt' })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel('Authority Passport')).toBeVisible();
    await page.getByRole('button', { name: 'Evaluate purchase' }).focus();
    await expect(page.getByRole('button', { name: 'Evaluate purchase' })).toBeFocused();
    expect(externalProviderRequests).toEqual([]);
  });

  test('Scenario 16: disallowed category, revocation-before-execution, and expiry fail closed', async ({ page }) => {
    const createPassport = async (agentId: string, agentDisplayName: string, allowedCategories: string[], expiresAt: string) => {
      const response = await page.evaluate(async (body) => {
        const raw = await fetch('/api/passports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: raw.status, ok: raw.ok, data: await raw.json() };
      }, {
        agentId, agentDisplayName, allowedMerchantIds: ['demo_store'], allowedCategories,
        maximumAmountPerTransactionPaise: 400000, cumulativeBudgetPaise: 1000000,
        approvalRequiredAbovePaise: 300000, maximumUsageCount: 4, expiresAt,
        idempotencyKey: `e2e-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      expect(response.ok).toBeTruthy();
      return response.data.passport;
    };

    const categoryPassport = await createPassport('books-only', 'Books Only', ['books'], new Date(Date.now() + 3600000).toISOString());
    await page.goto('/shop');
    await page.getByLabel('Authority Passport').selectOption(categoryPassport.passportId);
    await page.getByRole('button', { name: /2\. Wireless Mouse x1/ }).click();
    await page.getByRole('button', { name: 'Submit Proposal to Policy Engine' }).click();
    await expect(page.getByText('POLICY BLOCKED')).toBeVisible();
    await expect(page.getByText('CATEGORY_INTERSECTION_DENIED')).toBeVisible();
    await expect(page.getByText(/What would make it allowable/)).toBeVisible();

    const revokePassport = await createPassport('revoke-bot', 'Revoke Bot', ['electronics', 'books'], new Date(Date.now() + 3600000).toISOString());
    await page.goto('/shop');
    await page.getByLabel('Authority Passport').selectOption(revokePassport.passportId);
    await page.getByRole('button', { name: /3\. Systems Engineering Book x1/ }).click();
    await page.getByRole('button', { name: 'Submit Proposal to Policy Engine' }).click();
    await expect(page.getByText('READY FOR CHECKOUT')).toBeVisible();
    const revokeResponse = await page.evaluate(async (passportId) => {
      const raw = await fetch(`/api/passports/${passportId}/revoke`, { method: 'POST' });
      return { status: raw.status, ok: raw.ok };
    }, revokePassport.passportId);
    expect(revokeResponse.ok).toBeTruthy();
    await page.getByRole('button', { name: 'Execute with labeled mock provider' }).click();
    await expect(page.getByText('Purchase Proposal Blocked')).toBeVisible();
    await expect(page.getByText(/revoked|Authority passport changed/i).first()).toBeVisible();

    const expiringPassport = await createPassport('expiring-bot', 'Expiring Bot', ['electronics', 'books'], new Date(Date.now() + 5000).toISOString());
    await page.goto('/shop');
    await page.getByLabel('Authority Passport').selectOption(expiringPassport.passportId);
    await page.getByRole('button', { name: /3\. Systems Engineering Book x1/ }).click();
    await page.getByRole('button', { name: 'Submit Proposal to Policy Engine' }).click();
    await expect(page.getByText('READY FOR CHECKOUT')).toBeVisible();
    await page.waitForTimeout(6000);
    await page.getByRole('button', { name: 'Execute with labeled mock provider' }).click();
    await expect(page.getByText(/EXPIRED|Authorization expired or invalidated|Purchase Proposal Blocked/).first()).toBeVisible();
  });

  test('Scenario 17: passport endpoint ownership protection and logout remain enforced', async ({ page }) => {
    const response = await page.evaluate(async () => {
      const raw = await fetch('/api/passports/pass_nonexistent');
      return raw.status;
    });
    expect(response).toBe(404);
    await page.getByRole('button', { name: 'Logout' }).click();
    await page.waitForURL('/login');
    const unauthenticated = await page.evaluate(async () => (await fetch('/api/passports')).status);
    expect(unauthenticated).toBe(401);
  });
});
