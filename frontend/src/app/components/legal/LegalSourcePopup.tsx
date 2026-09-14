import { Modal } from "@/app/components/modals/Modal";
import { LegalSourceViewer, type LegalSourceTab } from "./LegalSourceViewer";

/** A source opened from a workspace pops over it, so the list the reader was opened from stays put. */
export function LegalSourcePopup({ tab, onClose }: { tab: LegalSourceTab; onClose: () => void }) {
    return <Modal open onClose={onClose} size="2xl" breadcrumbs={[tab.name || tab.citation]}>
        <LegalSourceViewer {...tab} navigationRequest={tab} compact />
    </Modal>;
}
