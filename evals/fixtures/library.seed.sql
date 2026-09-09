-- Deterministic seed for the library fixture. Dialect-agnostic literals only.

INSERT INTO members (member_id, full_name, joined_on, branch_code) VALUES
 (1,'Nadia Rahman','2022-03-04','NORTH'),
 (2,'Owen Blackwood','2022-07-19','SOUTH'),
 (3,'Priya Raman','2023-01-26','NORTH'),
 (4,'Quentin Ferreira','2023-06-11','EAST'),
 (5,'Rosa Iglesias','2024-02-02','SOUTH'),
 (6,'Sami Toure','2024-08-15','EAST');

INSERT INTO titles (title_id, title_name, author, genre) VALUES
 (1,'Tidal Reckoning','H. Marlowe','fiction'),
 (2,'The Glass Aqueduct','H. Marlowe','fiction'),
 (3,'Concrete Seasons','J. Okonkwo','fiction'),
 (4,'Counting Rivers','L. Sorensen','reference'),
 (5,'Atlas of Minor Roads','L. Sorensen','reference'),
 (6,'Kettle Logic','M. Devi','essays'),
 (7,'Night Shift Botany','M. Devi','essays'),
 (8,'Salt and Ledger','P. Nakamura','history');

INSERT INTO copies (copy_id, title_id, acquired_on, condition_code) VALUES
 (1,1,'2022-01-10','good'),
 (2,1,'2023-05-02','fair'),
 (3,2,'2022-01-10','good'),
 (4,3,'2022-09-30','good'),
 (5,4,'2021-11-05','worn'),
 (6,4,'2024-01-08','good'),
 (7,5,'2023-03-17','fair'),
 (8,6,'2023-08-21','good'),
 (9,7,'2024-04-04','good'),
 (10,8,'2022-06-14','worn');

INSERT INTO loans (loan_id, copy_id, member_id, loaned_on, returned_on) VALUES
 (1,1,1,'2024-01-05','2024-01-19'),
 (2,3,1,'2024-02-11','2024-03-02'),
 (3,4,2,'2024-02-20','2024-03-05'),
 (4,5,3,'2024-03-08','2024-03-15'),
 (5,6,3,'2024-04-01',NULL),
 (6,7,4,'2024-04-22','2024-05-06'),
 (7,8,2,'2024-05-13','2024-05-20'),
 (8,9,5,'2024-06-02',NULL),
 (9,10,1,'2024-06-18','2024-07-09'),
 (10,2,4,'2024-07-01','2024-07-08'),
 (11,3,5,'2024-07-25',NULL),
 (12,1,6,'2024-08-09','2024-08-16');

INSERT INTO fines (fine_id, loan_id, amount_cents, paid) VALUES
 (1,2,450,1),
 (2,4,120,1),
 (3,6,300,0),
 (4,9,875,0),
 (5,10,150,1);
