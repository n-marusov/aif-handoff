import { useState, useCallback } from "react";

interface UseEditModeReturn<T> {
  isEditing: boolean;
  draft: T;
  setDraft: (value: T) => void;
  /** Войти в режим редактирования и инициализировать черновик переданным значением. */
  startEditing: (value: T) => void;
  /** Сохранить черновик и выйти из режима редактирования. Возвращает значение черновика. */
  save: () => T;
  /** Отменить черновик и выйти из режима редактирования. */
  cancel: () => void;
}

/**
 * Управляет состоянием isEditing и draft для встроенного редактирования.
 * @param initialDraft — резервное значение черновика вне режима редактирования
 */
export function useEditMode<T>(initialDraft: T): UseEditModeReturn<T> {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<T>(initialDraft);

  const startEditing = useCallback((value: T) => {
    setDraft(value);
    setIsEditing(true);
  }, []);

  const save = useCallback((): T => {
    setIsEditing(false);
    return draft;
  }, [draft]);

  const cancel = useCallback(() => {
    setDraft(initialDraft);
    setIsEditing(false);
  }, [initialDraft]);

  return { isEditing, draft, setDraft, startEditing, save, cancel };
}
