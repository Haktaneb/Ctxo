module lending

go 1.22

require (
	github.com/jackc/pgx/v5 v5.0.0
	github.com/jmoiron/sqlx v1.0.0
	gorm.io/gorm v1.0.0
)

replace (
	github.com/jmoiron/sqlx => ./stubs/sqlx
	github.com/jackc/pgx/v5 => ./stubs/pgx
	gorm.io/gorm => ./stubs/gorm
)
