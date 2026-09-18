import { check } from "k6";
import http from "k6/http";

// Базовый URL берётся из окружения, чтобы одни и те же скрипты работали против
// локального dev и staging без правок. По умолчанию — локальный dev-API на :3009.
export const BASE_URL = __ENV.AIF_API_URL || "http://localhost:3009";

// Общие теги попадают в сводку k6, чтобы разделять проверки по эндпоинтам,
// когда скрипты покрывают несколько маршрутов.
export function tag(name) {
  return { tags: { endpoint: name } };
}

// Первый id проекта из dev-БД определяется на фазе setup, чтобы все VU
// не платили за этот запрос отдельно.
export function resolveFirstProjectId() {
  const res = http.get(`${BASE_URL}/projects`);
  if (res.status !== 200) {
    throw new Error(`GET /projects returned ${res.status}; is the API up at ${BASE_URL}?`);
  }
  const body = res.json();
  if (!Array.isArray(body) || body.length === 0) {
    return null;
  }
  return body[0].id;
}

export function okStatus(name) {
  return (res) => {
    return check(res, {
      [`${name}: status 200`]: (r) => r.status === 200,
      [`${name}: has body`]: (r) => typeof r.body === "string" && r.body.length >= 0,
    });
  };
}
