do $$ begin
  if exists(select 1 from public.mfg_bom_versions where status='draft') then
    raise exception 'rollback_refused_bom_drafts_exist';
  end if;
end $$;
drop function if exists public.save_mfg_bom_draft(bigint,bigint,numeric,jsonb,text,text);
drop index if exists public.mfg_bom_versions_one_draft_idx;
