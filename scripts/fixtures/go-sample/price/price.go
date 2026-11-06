package price

// Total returns the sum of the given line amounts.
func Total(lines []int) int {
	sum := 0
	for _, l := range lines {
		sum += l
	}
	return sum
}
