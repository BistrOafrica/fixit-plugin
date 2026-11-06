package price

import "testing"

func TestTotal(t *testing.T) {
	t.Run("sums", func(t *testing.T) {
		if got := Total([]int{1, 2, 3}); got != 6 {
			t.Errorf("expected 6, got %d", got)
		}
	})
	t.Run("empty", func(t *testing.T) {
		if got := Total(nil); got != 0 {
			t.Errorf("expected 0, got %d", got)
		}
	})
}

func TestNothing(t *testing.T) {}
