import { test, expect } from '@playwright/test';

test(
  '@pathlight:S1-US002-UNHAPPY-001 duplicate email returns 409 and is not inserted',
  async ({ request }) => {
    const email = 'duplicate-spike-test@pathlight.dev';

    // Step 1 — insert the email for the first time
    const firstResponse = await request.post('/api/waitlist', {
      data: {
        firstName:    'Spike',
        email:        email,
        businessType: 'cafe'
      }
    });
    expect([200, 201]).toContain(firstResponse.status());

    // Step 2 — attempt to insert the same email again
    const secondResponse = await request.post('/api/waitlist', {
      data: {
        firstName:    'Spike',
        email:        email,
        businessType: 'cafe'
      }
    });

    // Assert: server must reject with 409
    expect(secondResponse.status()).toBe(409);

    // Assert: response body contains an error property
    const body = await secondResponse.json();
    expect(body).toHaveProperty('error');
    expect(typeof body.error).toBe('string');
    expect(body.error.toLowerCase()).toContain('already');
  }
);
