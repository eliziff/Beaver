-- Deterministic per-document drafting preferences. The model emits semantic
-- content; Beaver owns citation placement and boilerplate presentation.
alter table public.user_profiles
  add column if not exists drafting_style jsonb not null
  default '{"version":1,"documents":{"memo":{"citationPlacement":"footnotes","numberHeadings":false},"factum":{"citationPlacement":"inline","numberHeadings":true},"letter":{"citationPlacement":"footnotes","numberHeadings":false},"other":{"citationPlacement":"inline","numberHeadings":"auto"}},"memoHeader":{"to":"File","from":"AI Assistant"}}'::jsonb;
