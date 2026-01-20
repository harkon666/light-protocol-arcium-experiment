use dep::std;

fn main(
    ship_x: u8,
    ship_y: u8,
    orientation: u8, // 0 = Horizontal, 1 = Vertical
    salt: Field
) -> pub Field {
    // 1. Constrain: Coordinates within 5x5 grid
    assert(ship_x < 5);
    assert(ship_y < 5);

    // 2. Constrain: Ship length = 4. Check bounds.
    let length = 4;
    // If Horizontal (0)
    if orientation == 0 {
        assert(ship_x + length <= 5);
    } else {
        // If Vertical (1)
        assert(ship_y + length <= 5);
    }

    // 3. Compute Commitment (Hash of placement + salt)
    // We convert u8 to Field for hashing
    let x_field = ship_x as Field;
    let y_field = ship_y as Field;
    let orient_field = orientation as Field;
    
    // Hash elements: [x, y, orientation, salt]
    let commitment = std::hash::pedersen_hash([x_field, y_field, orient_field, salt]);
    
    commitment
}

#[test]
fn test_valid_horizontal() {
    let commit = main(0, 0, 0, 123);
    // Should pass
}

#[test]
fn test_valid_vertical() {
    let commit = main(4, 0, 1, 123); // x=4, y=0, Vertical (fits: y 0,1,2,3)
    // Should pass
}

#[test(should_fail)]
fn test_invalid_bound_horizontal() {
    let commit = main(2, 0, 0, 123); // x=2, len=4 -> 2+4=6 > 5. Fail.
}

#[test(should_fail)]
fn test_invalid_bound_vertical() {
    let commit = main(0, 2, 1, 123); // y=2, len=4 -> 2+4=6 > 5. Fail.
}
