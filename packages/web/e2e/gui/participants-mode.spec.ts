import { expect, test, type APIRequestContext } from "@playwright/test";
import { API_URL, openProjectBoard } from "./common";

async function readParticipantsMode(request: APIRequestContext): Promise<boolean> {
  const sessionResponse = await request.get(`${API_URL}/auth/session`);
  expect(sessionResponse.ok()).toBe(true);
  const session = (await sessionResponse.json()) as { participantsModeEnabled: boolean };
  return session.participantsModeEnabled;
}

// BR: BR-constraint.auth.sessions, BR-fact.auth.roles
// FR: REQ-FR-auth.registration.sign-up-participant, REQ-FR-auth.roles.assign-participant-role
// NFR: REQ-NFR-security.compliance.session-auth
// KI: KI-03
// Matrix contract: enabled environments expose auth-gated participants flow.
test("participants-mode matrix (enabled): режим участников включён", async ({ request, page }) => {
  const participantsModeEnabled = await readParticipantsMode(request);
  test.skip(
    !participantsModeEnabled,
    "participants-mode matrix: requires PARTICIPANTS_MODE_ENABLED=true",
  );

  const participantsResponse = await request.get(`${API_URL}/participants`);
  if (!participantsResponse.ok()) {
    const body = (await participantsResponse.json()) as { code?: string };
    expect(body.code).not.toBe("participants_mode_disabled");
  }

  await page.context().clearCookies();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to AI Factory" })).toBeVisible();
});

// BR: BR-constraint.auth.sessions, BR-fact.auth.roles
// FR: REQ-FR-auth.registration.sign-up-participant, REQ-FR-auth.roles.assign-participant-role
// NFR: REQ-NFR-security.compliance.session-auth
// KI: KI-03
// Matrix contract: disabled environments bypass auth UI and report explicit disabled code.
test("participants-mode matrix (disabled): режим участников выключен", async ({
  request,
  page,
}) => {
  const participantsModeEnabled = await readParticipantsMode(request);
  test.skip(
    participantsModeEnabled,
    "participants-mode matrix: requires PARTICIPANTS_MODE_ENABLED=false",
  );

  const participantsResponse = await request.get(`${API_URL}/participants`);
  expect(participantsResponse.ok()).toBe(false);
  const body = (await participantsResponse.json()) as { code?: string };
  expect(body.code).toBe("participants_mode_disabled");

  await openProjectBoard(page);
  await expect(page.getByRole("heading", { name: "Sign in to AI Factory" })).toBeHidden();
});
