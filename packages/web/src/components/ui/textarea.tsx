import * as React from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  createOverlayLayerId,
  isTopOverlayLayer,
  pushOverlayLayer,
} from "@/components/ui/overlayStack";

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  containerClassName?: string;
  expandable?: boolean;
  expandLabel?: string;
}

const baseTextareaClasses =
  "flex min-h-[60px] w-full rounded-none border border-input bg-card/80 px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      className,
      containerClassName,
      expandable = true,
      expandLabel = "Expand to fullscreen",
      onKeyDown,
      disabled,
      ...props
    },
    ref,
  ) => {
    const [expanded, setExpanded] = React.useState(false);
    const innerRef = React.useRef<HTMLTextAreaElement | null>(null);
    const overlayRef = React.useRef<HTMLTextAreaElement | null>(null);
    const overlayLayerId = React.useRef(createOverlayLayerId("textarea-fullscreen"));
    const selectionRef = React.useRef<{ start: number; end: number } | null>(null);

    React.useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement, []);

    const captureSelection = (node: HTMLTextAreaElement | null) => {
      if (!node) return;
      selectionRef.current = {
        start: node.selectionStart ?? 0,
        end: node.selectionEnd ?? 0,
      };
    };

    const openFullscreen = () => {
      captureSelection(innerRef.current);
      setExpanded(true);
    };

    const closeFullscreen = () => {
      captureSelection(overlayRef.current);
      setExpanded(false);
    };

    React.useEffect(() => {
      const target = expanded ? overlayRef.current : innerRef.current;
      if (!target) return;
      if (expanded) target.focus();
      const sel = selectionRef.current;
      if (sel) {
        try {
          target.setSelectionRange(sel.start, sel.end);
        } catch {
          // игнорируем — элемент может не поддерживать selection ranges в текущем состоянии
        }
      }
    }, [expanded]);

    React.useEffect(() => {
      if (!expanded) return;
      const dispose = pushOverlayLayer(overlayLayerId.current);
      const onDocKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        if (!isTopOverlayLayer(overlayLayerId.current)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        captureSelection(overlayRef.current);
        setExpanded(false);
      };
      document.addEventListener("keydown", onDocKeyDown, true);
      return () => {
        document.removeEventListener("keydown", onDocKeyDown, true);
        dispose();
      };
    }, [expanded]);

    const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented) return;
      if (expandable && event.key === "F11" && event.shiftKey) {
        event.preventDefault();
        if (expanded) closeFullscreen();
        else openFullscreen();
      }
    };

    const valueLength =
      typeof props.value === "string"
        ? props.value.length
        : typeof props.defaultValue === "string"
          ? props.defaultValue.length
          : 0;

    const showButton = expandable && !disabled;

    return (
      <div className={cn("relative", containerClassName)}>
        <textarea
          {...props}
          ref={innerRef}
          disabled={disabled}
          onKeyDown={handleKeyDown}
          className={cn(baseTextareaClasses, showButton && "pr-9", className)}
        />
        {showButton && (
          <button
            type="button"
            onClick={openFullscreen}
            aria-label={expandLabel}
            title={`${expandLabel} (Shift+F11)`}
            tabIndex={-1}
            className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        )}
        {expanded &&
          typeof document !== "undefined" &&
          createPortal(
            <div
              className="fixed inset-0"
              style={{ zIndex: "var(--z-modal)" }}
              role="dialog"
              aria-modal="true"
              aria-label={expandLabel}
            >
              <div
                className="fixed inset-0 bg-black/85 animate-in fade-in-0"
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget) closeFullscreen();
                }}
              />
              <div className="fixed inset-0 flex items-stretch justify-center p-4 sm:p-8">
                <div className="relative flex w-full max-w-5xl flex-col gap-2">
                  <div className="flex items-center justify-between text-xs text-white/80">
                    <span>
                      {valueLength} {valueLength === 1 ? "char" : "chars"}
                    </span>
                    <button
                      type="button"
                      onClick={closeFullscreen}
                      aria-label="Collapse fullscreen"
                      title="Collapse (Esc)"
                      className="inline-flex h-7 w-7 items-center justify-center text-white/80 hover:text-white"
                    >
                      <Minimize2 className="h-4 w-4" />
                    </button>
                  </div>
                  <textarea
                    {...props}
                    ref={overlayRef}
                    disabled={disabled}
                    onKeyDown={handleKeyDown}
                    className={cn(
                      "flex h-full w-full flex-1 rounded-none border border-input bg-card/95 px-4 py-3 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                    )}
                  />
                </div>
              </div>
            </div>,
            document.body,
          )}
      </div>
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
