package main

import (
	"context"
	"database/sql"
	"log/slog"
	"time"

	pb "rusve/proto"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

/**
* Check if user exists, if not create new user
 */
func (s *server) Auth(ctx context.Context, in *pb.AuthRequest) (*pb.User, error) {
	start := time.Now()
	rules := map[string]string{
		"Email": "required,max=100,email",
		"Sub":   "required,max=100",
	}
	validate.RegisterStructValidationMapRules(rules, pb.AuthRequest{})
	err := validate.Struct(in)
	if err != nil {
		slog.Error("validate.Struct", "error", err)
		return nil, status.Error(codes.InvalidArgument, "Invalid email or code")
	}

	row := db.QueryRow(`select * from users where email = $1`, in.Email)
	user, err := mapUser(nil, row)
	if err != nil && err != sql.ErrNoRows {
		slog.Error("mapUser", "error", err)
		return nil, err
	}

	if user.GetDeleted() != "" {
		return nil, status.Error(codes.Unauthenticated, "Unauthenticated")
	}

	if err == sql.ErrNoRows {
		role := pb.UserRole_ROLE_USER
		row = db.QueryRow(`insert into users (email, role, sub) values ($1, $2, $3) returning *`, in.Email, role, in.Sub)
		user, err = mapUser(nil, row)
		if err != nil {
			slog.Error("mapUser", "error", err)
			return nil, err
		}
	}

	slog.Info("Auth", "time", time.Since(start))
	return user, nil
}

func (s *server) GetUsers(in *pb.UserIds, stream pb.UsersService_GetUsersServer) error {
	start := time.Now()

	rows, err := db.Query(`select * from users where id = any($1)`, in.UserIds)
	if err != nil {
		slog.Error("db.Query", "error", err)
		return err
	}
	defer rows.Close()

	for rows.Next() {
		user, err := mapUser(rows, nil)
		if err != nil {
			slog.Error("mapUser", "error", err)
			return err
		}
		err = stream.Send(user)
		if err != nil {
			slog.Error("stream.Send", "error", err)
			return err
		}
	}
	if rows.Err() != nil {
		slog.Error("rows.Err", "error", err)
		return err
	}

	slog.Info("GetUsers", "time", time.Since(start))
	return nil
}

func (s *server) GetUser(ctx context.Context, in *pb.UserId) (*pb.User, error) {
	start := time.Now()

	row := db.QueryRow(`select * from users where id = $1`, in.UserId)
	user, err := mapUser(nil, row)
	if err != nil {
		slog.Error("mapUser", "error", err)
		return nil, err
	}

	slog.Info("GetUser", "time", time.Since(start))
	return user, nil
}

func (s *server) UpdateUser(ctx context.Context, in *pb.User) (*pb.Empty, error) {
	start := time.Now()

	_, err := db.Exec(`update users set name = $1, avatar_id = $2 where id = $3 and deleted is null`, in.Name, in.AvatarId, in.Id)
	if err != nil {
		slog.Error("db.Exec", "error", err)
		return nil, err
	}

	slog.Info("UpdateUser", "time", time.Since(start))
	return &pb.Empty{}, nil
}

func (s *server) DeleteUser(ctx context.Context, in *pb.User) (*pb.Empty, error) {
	start := time.Now()

	_, err := db.Exec(`update users set deleted = now() where id = $1 and sub = $2 and email = $3`, in.Id, in.Sub, in.Email)
	if err != nil {
		slog.Error("db.Exec", "error", err)
		return nil, err
	}

	slog.Info("DeleteUser", "time", time.Since(start))
	return &pb.Empty{}, nil
}
