-- Shared deterministic seed data. Dialect-agnostic: plain literals only,
-- so the same file loads into both the SQLite and PostgreSQL fixtures.

INSERT INTO customers (id, name, email, country, created_at) VALUES
 (1,'Amina Farouk','amina@example.com','EG','2023-01-15'),
 (2,'Bilal Haddad','bilal@example.com','AE','2023-02-03'),
 (3,'Clara Novak','clara@example.com','DE','2023-02-20'),
 (4,'Diego Torres','diego@example.com','ES','2023-05-11'),
 (5,'Elena Petrova','elena@example.com','DE','2023-07-30'),
 (6,'Farid Mansour','farid@example.com','AE','2024-01-08'),
 (7,'Grace Okoro','grace@example.com','NG','2024-03-19'),
 (8,'Hana Suzuki','hana@example.com','JP','2024-06-02');

INSERT INTO categories (id, name) VALUES
 (1,'Keyboards'),(2,'Monitors'),(3,'Audio'),(4,'Storage'),(5,'Accessories');

INSERT INTO products (id, name, category_id, price, stock, created_at) VALUES
 (1,'Mech Keyboard 68',1,89.00,42,'2023-01-05'),
 (2,'Mech Keyboard 87',1,109.00,17,'2023-01-05'),
 (3,'Low Profile 60',1,129.00,0,'2023-09-14'),
 (4,'27in QHD Monitor',2,319.00,8,'2023-02-11'),
 (5,'32in 4K Monitor',2,549.00,3,'2023-02-11'),
 (6,'Studio Headphones',3,199.00,25,'2023-03-22'),
 (7,'USB Microphone',3,139.00,11,'2023-08-01'),
 (8,'1TB NVMe SSD',4,99.00,60,'2023-04-17'),
 (9,'2TB NVMe SSD',4,179.00,31,'2023-04-17'),
 (10,'Laptop Stand',5,45.00,120,'2023-06-09'),
 (11,'USB-C Hub',5,59.00,74,'2023-06-09'),
 (12,'Desk Mat XL',5,29.00,0,'2024-02-27');

INSERT INTO orders (id, customer_id, status, order_date, total) VALUES
 (1,1,'delivered','2024-01-12',188.00),
 (2,1,'delivered','2024-02-19',319.00),
 (3,2,'delivered','2024-02-25',298.00),
 (4,3,'cancelled','2024-03-02',549.00),
 (5,3,'delivered','2024-03-14',144.00),
 (6,4,'shipped','2024-04-08',179.00),
 (7,5,'delivered','2024-04-21',627.00),
 (8,2,'pending','2024-05-05',45.00),
 (9,6,'delivered','2024-05-17',248.00),
 (10,7,'delivered','2024-06-01',109.00),
 (11,5,'shipped','2024-06-23',388.00),
 (12,8,'pending','2024-07-04',59.00),
 (13,1,'delivered','2024-07-19',99.00),
 (14,6,'cancelled','2024-08-02',199.00),
 (15,4,'delivered','2024-08-27',357.00);

INSERT INTO order_items (id, order_id, product_id, quantity, unit_price) VALUES
 (1,1,1,1,89.00),(2,1,11,1,59.00),(3,1,10,1,40.00),
 (4,2,4,1,319.00),
 (5,3,6,1,199.00),(6,3,7,1,99.00),
 (7,4,5,1,549.00),
 (8,5,11,1,59.00),(9,5,10,1,45.00),(10,5,12,2,20.00),
 (11,6,9,1,179.00),
 (12,7,5,1,549.00),(13,7,10,1,45.00),(14,7,12,1,33.00),
 (15,8,10,1,45.00),
 (16,9,8,1,99.00),(17,9,7,1,139.00),(18,9,12,1,10.00),
 (19,10,2,1,109.00),
 (20,11,4,1,319.00),(21,11,11,1,59.00),(22,11,12,1,10.00),
 (23,12,11,1,59.00),
 (24,13,8,1,99.00),
 (25,14,6,1,199.00),
 (26,15,9,2,179.00);

INSERT INTO payments (id, order_id, method, amount, paid_at, status) VALUES
 (1,1,'card',188.00,'2024-01-12','captured'),
 (2,2,'card',319.00,'2024-02-19','captured'),
 (3,3,'paypal',298.00,'2024-02-25','captured'),
 (4,4,'card',549.00,'2024-03-02','refunded'),
 (5,5,'card',144.00,'2024-03-14','captured'),
 (6,6,'transfer',179.00,'2024-04-09','captured'),
 (7,7,'card',627.00,'2024-04-21','captured'),
 (8,9,'card',248.00,'2024-05-17','captured'),
 (9,10,'paypal',109.00,'2024-06-01','captured'),
 (10,11,'card',388.00,'2024-06-23','pending'),
 (11,13,'card',99.00,'2024-07-19','captured'),
 (12,14,'card',199.00,'2024-08-02','refunded'),
 (13,15,'transfer',357.00,'2024-08-27','captured'),
 (14,15,'card',0.00,'2024-08-28','failed');

INSERT INTO reviews (id, product_id, customer_id, rating, comment, created_at) VALUES
 (1,1,1,5,'Great feel','2024-01-20'),
 (2,11,1,4,NULL,'2024-01-21'),
 (3,4,1,5,'Sharp panel','2024-02-28'),
 (4,6,2,4,'Comfortable','2024-03-05'),
 (5,7,2,2,'Picks up noise','2024-03-06'),
 (6,11,3,5,'Just works','2024-03-20'),
 (7,5,5,5,'Huge','2024-04-30'),
 (8,10,5,3,NULL,'2024-05-01'),
 (9,8,6,4,'Fast','2024-05-25'),
 (10,2,7,5,'Worth it','2024-06-10'),
 (11,4,5,4,'Good value','2024-07-01'),
 (12,9,4,1,'Failed after a week','2024-09-03');
