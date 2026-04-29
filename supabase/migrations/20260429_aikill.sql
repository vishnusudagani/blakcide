-- SympOS — AI Voice emergency kill switch.
--
-- Adds an `ai_voice_killswitch` row to the existing public.global_settings
-- key/value table. When { enabled: true }, the chat-stream / voice / vision
-- functions return a soft 503 with a calm message instead of calling the
-- model. Default is OFF — flipping it on is an explicit incident response.

insert into public.global_settings (key, value)
values ('ai_voice_killswitch', '{"enabled": false}'::jsonb)
on conflict (key) do nothing;
