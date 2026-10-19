-- Included inside the main seed transaction. Preserve canonical English seeds.
WITH names(slug,fr,ar,fr_description,ar_description) AS (VALUES
 ('home_maintenance','Maison et entretien','المنزل والصيانة','Plomberie, électricité et entretien de la maison','السباكة والكهرباء وصيانة المنزل'),
 ('education','Éducation','التعليم','Cours particuliers et accompagnement scolaire','الدروس الخصوصية والمساعدة الدراسية'),
 ('technology','Technologie','التكنولوجيا','Développement logiciel et ingénierie','تطوير البرمجيات والخدمات الهندسية'),
 ('food_hospitality','Cuisine et accueil','الطعام والضيافة','Cuisine à domicile et services pour événements','الطبخ المنزلي وخدمات المناسبات'),
 ('healthcare','Soins de santé','الرعاية الصحية','Soins infirmiers et accompagnement à domicile','التمريض والرعاية المنزلية'),
 ('delivery_transport','Livraison et transport','التوصيل والنقل','Livraisons locales et courses','التوصيل المحلي وقضاء الحاجات')
)
INSERT INTO category_translations(category_id,language,name,description)
SELECT c.id,'fr',n.fr,n.fr_description FROM names n JOIN categories c ON c.slug=n.slug
UNION ALL SELECT c.id,'ar',n.ar,n.ar_description FROM names n JOIN categories c ON c.slug=n.slug
ON CONFLICT(category_id,language) DO NOTHING;
WITH names(slug,fr,ar) AS (VALUES
 ('plumber','Plombier','سباك'),('carpenter','Menuisier','نجار'),('cleaner','Nettoyage','تنظيف'),
 ('maintenance','Entretien et réparation','صيانة وتصليح'),('electrician','Électricien','كهربائي'),
 ('water_tank','Services de réservoir d’eau','خدمات خزانات المياه'),('janitor','Gardien d’immeuble','ناطور'),
 ('tutor','Enseignant et soutien scolaire','مدرس خصوصي'),('programmer','Développeur','مبرمج'),
 ('engineer','Ingénieur','مهندس'),('chef','Chef cuisinier','طباخ'),('barista','Barista','باريستا'),
 ('nurse','Soins infirmiers','تمريض'),('delivery','Livraison','توصيل')
)
INSERT INTO worker_type_translations(worker_type_id,language,name)
SELECT t.id,'fr',n.fr FROM names n JOIN worker_types t ON t.slug=n.slug
UNION ALL SELECT t.id,'ar',n.ar FROM names n JOIN worker_types t ON t.slug=n.slug
ON CONFLICT(worker_type_id,language) DO NOTHING;
