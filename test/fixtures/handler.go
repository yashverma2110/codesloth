// Package api serves HTTP.
package api

import (
	"context"
	"net/http"

	json "encoding/json"
	_ "github.com/lib/pq"
	. "github.com/acme/shop/internal/testutil"
	"github.com/acme/shop/internal/store" // comment after
	/* "github.com/acme/shop/internal/ignored" */
)

import "github.com/acme/shop/pkg/money"

type Handler struct{ s *store.Store }

var DefaultTimeout = 5

const (
	MaxItems = 10
	minItems = 1
)

func NewHandler(s *store.Store) *Handler { return &Handler{s: s} }

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	_ = json.NewEncoder(w).Encode(money.Zero())
	_ = context.Background()
}
