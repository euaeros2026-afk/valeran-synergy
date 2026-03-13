-- VALERAN · PARTNER PROFILES
-- Run this in Supabase SQL Editor
-- Replace REPLACE_WITH_*_EMAIL with real Google email addresses

INSERT INTO partners (full_name, display_name, role, preferred_language, at_fair, telegram_user_id) VALUES
('Alexander Oslan',       'Alexander', 'founder',  'en', true,  8796759210),
('Ina Kanaplianikava',    'Ina',       'founder',  'ru', true,  null),
('Konstantin Khoch',      'Kostia',    'founder',  'ru', true,  null),
('Konstantin Ganev',      'KK',        'founder',  'bg', true,  null),
('Slavi Mikinski',        'Slavi',     'observer', 'bg', false, null);

-- After running, update emails when you have them:
-- UPDATE partners SET email = 'xxx@gmail.com' WHERE display_name = 'Ina';

SELECT full_name, display_name, role, preferred_language, at_fair FROM partners;
