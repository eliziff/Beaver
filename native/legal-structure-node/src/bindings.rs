//! The TypeScript declarations of what the engine serves JavaScript and what it is asked with, generated from the Rust
//! types serde writes and reads (ts-rs, behind `binding-types`): package-time only, never part of a runtime build. The
//! export-types bin writes them to shared/engine-types.

use ts_rs::{Config, ExportError, TS};

/// Each declaration, and every type it names, written as `<name>.d.ts` in `directory`.
pub fn export_types(directory: &std::path::Path) -> Result<(), ExportError> {
    std::env::set_var("TS_RS_EXPORT_DIR", directory);
    let config = Config::default();
    macro_rules! export { ($($type:ty),+ $(,)?) => { $(<$type>::export_all(&config)?;)+ }; }
    // The structure, its nodes as a reader takes them, and the queries over a document.
    export!(
        legal_structure::DocumentStructure,
        legal_structure::AuthoritativeTableCell,
        legal_structure::Passage<'static>,
        legal_structure::Locator,
        legal_structure::DocumentLookup<'static>,
        legal_structure::DocumentRangeLookup<'static>,
        legal_structure::DocumentTextWindow<'static>,
        legal_structure::DocumentAddressResolution,
        legal_structure::FollowDirection,
        legal_structure::GraphScopeSeed,
        legal_structure::GraphScope<'static>,
        legal_structure::DocumentViewer<'static>,
        legal_structure::TextFragmentPlan,
    );
    // Readings of text, and what a document is derived from.
    export!(
        legal_structure::CitationOccurrence,
        legal_structure::AuthorityReferenceOccurrence,
        legal_structure::ProviderCitationMatch,
        legal_structure::FilingCover,
        legal_structure::ProviderTextInput,
        legal_structure::NativeMarkupInput,
        legal_structure::JournalPageLabel,
        legal_structure::opinion::OpinionRecord,
        crate::engine::StructureRequest,
        crate::engine::Failure,
    );
    // What the products build on the engine.
    export!(
        legal_structure_features::OutlineEntry,
        legal_structure_features::BriefText,
        legal_structure_features::BriefCitationOrder,
        legal_structure_features::FootnotePropositions,
        legal_structure_features::PropositionUnit,
        legal_structure_features::QuoteContext,
        legal_structure_features::QuotationDiff,
        legal_structure_features::QuoteComparison,
        legal_structure_features::QuoteSource,
        legal_structure_features::QuoteToLocate,
        legal_structure_features::LocatedQuote,
        legal_structure_features::JournalTitleSearch,
        legal_structure_features::JournalTitleHit,
        legal_structure_features::MarkedQuoteSpan,
        legal_structure_features::PassageLink,
        legal_structure_features::search_query::SearchQuery,
        legal_structure_features::AliasGroup,
        legal_structure_features::CitedBlock,
    );
    #[cfg(feature = "a2aj")]
    export!(
        crate::dispatch::StoreDocument,
        crate::dispatch::Provision,
        legal_structure_features::a2aj::Listing,
        legal_structure_features::a2aj_store::Lookup,
        legal_structure_features::a2aj_store::ProvisionLookup,
        legal_structure_features::a2aj_store::StoreRead,
        legal_structure_features::a2aj_store::Court,
        legal_structure_features::citator_graph::NoteUp,
        legal_structure_features::citator_graph::AuthorityMetric,
    );
    // ts-rs writes `.ts`; these are declarations.
    for entry in std::fs::read_dir(config.out_dir())? {
        let path = entry?.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        if name.ends_with(".ts") && !name.ends_with(".d.ts") {
            std::fs::rename(&path, path.with_extension("d.ts"))?;
        }
    }
    Ok(())
}
