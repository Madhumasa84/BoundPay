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
    await expect(page.locator('text=Subscriptions are strictly prohibited by standing policy')).toBeVisible();
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
    await expect(page.locator('text=MAX_TRANSACTION_LIMIT')).toBeVisible();
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
});
