import http from "k6/http";
import { BASE_URL, okStatus, tag } from "./common.js";

// Сценарий «топота» для /runtime-profiles: 20 виртуальных пользователей бьют по
// эндпоинту одновременно, так что серверный кеш обязан обслужить всех с одного
// дорогого сканирования. Это ровно та регрессия, которую мы починили: до правки
// холодный ответ был 14с, поэтому пороги исходят из ограниченного скана и
// снапшот-кеша на 60с.
export const options = {
  scenarios: {
    stampede: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "5s", target: 20 },
        { duration: "20s", target: 20 },
        { duration: "5s", target: 0 },
      ],
      gracefulRampDown: "5s",
    },
  },
  thresholds: {
    "http_req_failed{endpoint:runtime-profiles}": ["rate<0.01"],
    "http_req_duration{endpoint:runtime-profiles}": ["p(95)<8000", "p(99)<12000"],
  },
};

const check200 = okStatus("runtime-profiles");

export default function () {
  const res = http.get(
    `${BASE_URL}/runtime-profiles?includeGlobal=true&enabledOnly=false`,
    tag("runtime-profiles"),
  );
  check200(res);
}
