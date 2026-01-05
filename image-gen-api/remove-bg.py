#!/usr/bin/env python3
"""
Remove background from image using rembg
Usage: python remove-bg.py input.png output.png
"""

import sys
from rembg import remove
from PIL import Image

def remove_background(input_path, output_path):
    """Remove background from image"""
    try:
        # Open image
        with open(input_path, 'rb') as input_file:
            input_data = input_file.read()
        
        # Remove background
        output_data = remove(input_data)
        
        # Save result
        with open(output_path, 'wb') as output_file:
            output_file.write(output_data)
        
        print(f"✅ Background removed: {output_path}")
        return True
    except Exception as e:
        print(f"❌ Error removing background: {str(e)}", file=sys.stderr)
        return False

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python remove-bg.py input.png output.png")
        sys.exit(1)
    
    input_path = sys.argv[1]
    output_path = sys.argv[2]
    
    success = remove_background(input_path, output_path)
    sys.exit(0 if success else 1)
