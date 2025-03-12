import sqlite3
import json

# 1. Import your tables data here
# Example:
# from your_module import tables

def analyze_database_schema(db_path):
    try:
        # Connect to the SQLite database
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # Get all table schemas
        cursor.execute("SELECT name, sql FROM sqlite_master WHERE type='table'")
        tables = cursor.fetchall()
        
        # Analyze foreign keys
        foreign_keys = []
        for table_name, table_sql in tables:
            # Get foreign key information from pragma
            cursor.execute(f"PRAGMA foreign_key_list({table_name})")
            fk_info = cursor.fetchall()
            
            if fk_info:
                for fk in fk_info:
                    foreign_keys.append({
                        'table': table_name,
                        'from_column': fk[3],
                        'to_table': fk[2],
                        'to_column': fk[4]
                    })
        
        # Get table count
        table_count = len(tables)
        
        # Close connection
        conn.close()
        
        return {
            'foreign_keys': foreign_keys,
            'table_count': table_count,
            'found_fk_count': len(foreign_keys)
        }
        
    except Exception as e:
        return {'error': str(e)}

# 2. Run the analysis
if __name__ == "__main__":
    # Path to your SQLite database
    db_path = 'database.db'
    
    result = analyze_database_schema(db_path)
    print(json.dumps(result, indent=2)) 