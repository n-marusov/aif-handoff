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
// Disabled-mode regression (env-aware): asserts deterministic behavior when participants are off.
test("L-08: participants-mode disabled — вход не требуется и participants API выключен", async ({
  page,
  request,
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

// BR: BR-constraint.auth.sessions, BR-fact.auth.roles
// FR: REQ-FR-auth.registration.sign-up-participant, REQ-FR-auth.roles.assign-participant-role
// NFR: REQ-NFR-security.compliance.session-auth
// KI: KI-03
// Enabled-mode regression (env-aware): full auth flow is out of scope here, but mode contract must be deterministic.
test("L-08b: participants-mode enabled — LoginPage доступен и /participants не в disabled-коде", async ({
  page,
  request,
}) => {
  const participantsModeEnabled = await readParticipantsMode(request);
  test.skip(
    !participantsModeEnabled,
    "participants-mode matrix: requires PARTICIPANTS_MODE_ENABLED=true",
  );

  await page.context().clearCookies();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to AI Factory" })).toBeVisible();

  const participantsResponse = await request.get(`${API_URL}/participants`);
  if (!participantsResponse.ok()) {
    const body = (await participantsResponse.json()) as { code?: string };
    expect(body.code).not.toBe("participants_mode_disabled");
  }
});

// BR: BR-constraint.auth.sessions, BR-fact.auth.roles
// FR: REQ-FR-auth.roles.assign-participant-role
// NFR: REQ-NFR-security.compliance.session-auth
// KI: KI-03
// Negative UI assertion for disabled mode: participant menu does not appear.
test("L-06b: при выключенных участниках отсутствует participant-меню (negative)", async ({
  page,
  request,
}) => {
  const participantsModeEnabled = await readParticipantsMode(request);
  test.skip(
    participantsModeEnabled,
    "participants-mode matrix: requires PARTICIPANTS_MODE_ENABLED=false",
  );

  await openProjectBoard(page);
  await expect(page.getByRole("button", { name: "Participant menu for" })).toBeHidden({
    timeout: 5_000,
  });
  await expect(page.getByText("Manage participants", { exact: true })).toBeHidden();
});
