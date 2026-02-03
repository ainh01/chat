CREATE TABLE users (  
    id BIGINT PRIMARY KEY,  
    username VARCHAR(255) NOT NULL UNIQUE,  
    password_hash VARCHAR(255) NOT NULL,  
    created_at DATETIME2 DEFAULT GETDATE(),  
    updated_at DATETIME2 DEFAULT GETDATE()  
);  
GO  

CREATE INDEX idx_users_username ON users(username);  
GO  