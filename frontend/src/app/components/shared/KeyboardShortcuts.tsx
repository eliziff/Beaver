import { useEffect, useState } from "react";
import { Modal } from "@/app/components/modals/Modal";
const OPEN_LAYER = '[data-shortcut-layer][data-shortcut-open="true"]';
function isEditable(target: EventTarget | null) {
    return (
        target instanceof HTMLElement &&
        Boolean(
            target.closest(
                'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
            ),
        )
    );
}
function firstVisible<T extends HTMLElement>(selector: string) {
    return [...document.querySelectorAll<T>(selector)].find(
        (element) => element.getClientRects().length > 0 && !element.hidden,
    );
}
export function KeyboardShortcuts() {
    const [helpOpen, setHelpOpen] = useState(false);
    useEffect(() => {
        function handleKeyDown(event: KeyboardEvent) {
            if (event.defaultPrevented) return;
            if (
                event.key === "Escape" &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.shiftKey
            ) {
                const layers = [
                    ...document.querySelectorAll<HTMLElement>(OPEN_LAYER),
                ];
                const focusedLayer =
                    event.target instanceof Element
                        ? event.target.closest<HTMLElement>(OPEN_LAYER)
                        : document.activeElement instanceof Element
                          ? document.activeElement.closest<HTMLElement>(
                                OPEN_LAYER,
                            )
                          : null;
                const layer = focusedLayer ?? layers[layers.length - 1];
                const close = layer?.matches("[data-shortcut-close]")
                    ? layer
                    : layer?.querySelector<HTMLElement>(
                          "[data-shortcut-close]",
                      );
                if (!close) return;
                event.preventDefault();
                event.stopPropagation();
                close.click();
                if (close !== layer && close.isConnected) close.focus();
                return;
            }
            if (isEditable(event.target)) return;
            if (event.ctrlKey || event.metaKey) return;
            if (event.key === "/" && !event.altKey) {
                const search =
                    firstVisible<HTMLInputElement>("[data-page-search]");
                if (!search || search.disabled) return;
                event.preventDefault();
                search.focus();
                return;
            }
            if (
                event.key.toLowerCase() === "n" &&
                event.altKey &&
                !event.shiftKey
            ) {
                const action = firstVisible<HTMLButtonElement>(
                    "[data-page-new]:not(:disabled)",
                );
                if (!action || action.getAttribute("aria-disabled") === "true")
                    return;
                event.preventDefault();
                action.click();
                return;
            }
            if (event.key === "?" && !event.altKey) {
                event.preventDefault();
                setHelpOpen(true);
            }
        }
        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, []);
    return (
        <Modal
            open={helpOpen}
            onClose={() => setHelpOpen(false)}
            breadcrumbs={["Keyboard shortcuts"]}
            size="sm"
            className="!h-auto"
        >
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 pb-5 pt-2 text-sm">
                <dt><kbd>/</kbd></dt>
                <dd>Search this page</dd>
                <dt><kbd>Alt N</kbd></dt>
                <dd>Create a new item</dd>
                <dt><kbd>?</kbd></dt>
                <dd>Show shortcuts</dd>
                <dt><kbd>Esc</kbd></dt>
                <dd>Close the top panel</dd>
            </dl>
        </Modal>
    );
}
