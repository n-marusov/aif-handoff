// Сохранение плана задачи сразу в двух местах: в базу и в канонический файл.
//
// Файл нужен потому, что план читают люди и внешние инструменты (в том числе ревью
// в PR/MR), а база - источник истины для конвейера. Обе записи выполняются в одной
// функции, чтобы они не разошлись: файл без строки в базе или наоборот.
//
// Модуль переехал из @aif/shared в слой персистентности (@aif/data): запись в БД
// и работа с файлом - это операция приложения поверх хранилища, а не чистый
// контракт, поэтому здесь его место.

import { eq } from "drizzle-orm";
import { projects, tasks, syncPlanTextToCanonicalFile } from "@aif/shared";
import { getDb } from "./db.js";

interface PersistTaskPlanInput {
  db: ReturnType<typeof getDb>;
  taskId: string;
  planText: string | null;
  updatedAt?: string;
  projectRoot?: string;
  isFix?: boolean;
  planPath?: string;
}

// projectRoot, isFix и planPath можно не передавать: тогда они дочитываются из базы.
// Дополнительные запросы выполняются только при нехватке данных - тот вызывающий
// код, которому всё уже известно, не платит за лишние выборки.
export function persistTaskPlan(input: PersistTaskPlanInput): { updatedAt: string } {
  let projectRoot = input.projectRoot;
  let isFix = input.isFix;
  let planPath = input.planPath;

  if (!projectRoot || isFix == null) {
    const task = input.db
      .select({
        projectId: tasks.projectId,
        isFix: tasks.isFix,
        planPath: tasks.planPath,
      })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .get();

    // Отсутствие задачи - ошибка вызывающего кода, а не штатная ситуация: молча
    // записать план без задачи означало бы осиротевший файл на диске.
    if (!task) {
      throw new Error(`Task ${input.taskId} not found`);
    }

    const project = input.db
      .select({
        rootPath: projects.rootPath,
      })
      .from(projects)
      .where(eq(projects.id, task.projectId))
      .get();

    if (!project) {
      throw new Error(`Project not found for task ${input.taskId}`);
    }

    projectRoot = project.rootPath;
    isFix = task.isFix;
    // Явно переданный planPath приоритетнее сохранённого в задаче: так вызывающий
    // может перенаправить план, не меняя запись в базе.
    planPath = planPath ?? task.planPath;
  }

  syncPlanTextToCanonicalFile({
    projectRoot,
    isFix,
    planPath,
    planText: input.planText,
  });

  // Метка времени генерируется один раз и идёт и в ответ, и в базу: иначе они
  // разошлись бы на доли миллисекунды.
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  input.db
    .update(tasks)
    .set({
      plan: input.planText,
      updatedAt,
    })
    .where(eq(tasks.id, input.taskId))
    .run();

  return { updatedAt };
}
