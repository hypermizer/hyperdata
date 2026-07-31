create index if not exists paper_market_inputs_asset_kind_source_idx
on public.paper_market_inputs (asset, input_kind, source_timestamp desc);
