/**
 * Кольцевой буфер последних строк stderr для диагностики сбоев рантайма.
 *
 * Держится только хвост: полный вывод субагента может быть огромным, а для
 * сообщения об ошибке нужны последние строки. Разбиение идёт по "\n" внутри
 * каждого фрагмента, поэтому строка, разрезанная границей фрагмента, склеена не будет -
 * для диагностического хвоста это приемлемая плата за простоту.
 */

/** Универсальный кольцевой буфер stderr для вывода подпроцессов runtime. */
export interface StderrCollector {
  onStderr: (chunk: string) => void;
  getTail: () => string;
}

export function createStderrCollector(maxLines = 20): StderrCollector {
  // Хранилище ограничено maxLines, поэтому память не растёт вместе с выводом.
  const lines: string[] = [];

  return {
    onStderr: (chunk: string) => {
      for (const rawLine of chunk.split("\n")) {
        // Пустые и пробельные строки пропускаем: они вытесняли бы полезные записи.
        const line = rawLine.trim();
        if (!line) continue;
        lines.push(line);
        // shift убирает самую старую строку - в буфере остаются последние maxLines.
        if (lines.length > maxLines) lines.shift();
      }
    },
    // Однострочный вид: хвост удобно вставлять в лог и в текст ошибки.
    getTail: () => lines.join(" | "),
  };
}
