-- جدول إعدادات البوت — صف واحد فقط، يُعدَّل لاحقاً من لوحة تحكم بالموقع
create table if not exists bot_settings (
  id int primary key default 1,
  enabled boolean not null default false,
  position_pct numeric not null default 10,
  leverage int not null default 10,
  stop_loss_pct numeric not null default 30,
  take_profit_pct numeric not null default 25,
  max_concurrent_positions int not null default 5,
  updated_at timestamptz not null default now(),
  constraint single_row check (id = 1)
);

alter table bot_settings enable row level security;

-- إدراج الصف الافتراضي الوحيد إن لم يكن موجوداً (البوت مُعطَّل افتراضياً — أمان بالتصميم)
insert into bot_settings (id, enabled) values (1, false)
on conflict (id) do nothing;
