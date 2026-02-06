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


CREATE TABLE friendships (  
    user_id_1 BIGINT NOT NULL,  
    user_id_2 BIGINT NOT NULL,  
    created_at DATETIME2 DEFAULT GETDATE(),  
    
    PRIMARY KEY (user_id_1, user_id_2),  
    
    FOREIGN KEY (user_id_1) REFERENCES users(id),  
    FOREIGN KEY (user_id_2) REFERENCES users(id),  
    
    CHECK (user_id_1 < user_id_2)  
);  
GO  

CREATE INDEX idx_friendships_user1 ON friendships(user_id_1);  
GO  

CREATE INDEX idx_friendships_user2 ON friendships(user_id_2);  
GO  