import http from "k6/http";
import { BASE_URL, okStatus, resolveFirstProjectId, tag } from "./common.js";

// /tasks — только чтение SQLite; этот скрипт — индикатор регрессий вида
// «мы замедлили слой данных». Пороги намеренно жёсткие: эндпоинт не должен
// обращаться к файловой системе.
export const options = {
  scenarios: {
    steady: {
      executor: "constant-vus",
      vus: 20,
      duration: "20s",
    },
  },
  thresholds: {
    "http_req_failed{endpoint:tasks}": ["rate<0.01"],
    // Ответ ~100KB на список задач; при 20 VU основную стоимость дают
    // сериализация и join-ы SQLite. Бюджеты выставлены выше базовой линии
    // (~570ms p95), чтобы регрессия в 2-3 раза валила набор, а нормальная
    // нагрузка не давала ложных срабатываний.
    "http_req_duration{endpoint:tasks}": ["p(95)<1200", "p(99)<2000"],
  },
};

export function setup() {
  const projectId = resolveFirstProjectId();
  if (!projectId) {
    throw new Error(
      "No project present in the dev DB — seed a project before running the k6 tasks canary.",
    );
  }
  return { projectId };
}

const check200 = okStatus("tasks");

export default function (data) {
  const url = `${BASE_URL}/tasks?projectId=${encodeURIComponent(data.projectId)}`;
  const res = http.get(url, tag("tasks"));
  check200(res);
}
