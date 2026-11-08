//! The engine's readers of the formats that are neither PDF nor Word's own structure: a workbook's grid, a
//! presentation's slides, an email, and a Word document's redline. Each gives the text the engine derives the
//! document's structure from (engine::open_source), and a workbook the cells its text was rendered from.

pub mod email;
pub mod redline;
pub mod sheet;
pub mod slides;
